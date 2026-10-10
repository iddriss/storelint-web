/**
 * What a paying client uses without an account:
 *
 *   GET  /o/:orderId/:token           private order page (progress, intake, timeline, messages)
 *   POST /o/:orderId/:token/intake    save the intake answers
 *   POST /o/:orderId/:token/message   send the team a message
 *   GET/POST /orders/find             email the private link(s) again
 *
 * The token in the URL is the only credential, so these pages are never cached, never
 * indexed and never sent as a referrer, and wrong guesses are rate limited per IP.
 */
import type { Context } from 'hono';
import { EMAIL_RE } from '../addresses.js';
import { safeEqual } from '../auth.js';
import type { OrderRow } from '../db.js';
import type { RouteContext } from '../http.js';
import { clientIp, privateHeaders, readForm, smallFormLimit } from '../http.js';
import type { IntakeErrors, IntakeFormValues } from '../intake-form.js';
import { defaultIntakeValues, findSecret, intakeToFormValues, parseIntake, secretMessage, validateIntake } from '../intake-form.js';
import { renderError } from '../views/html.js';
import { MESSAGE_MAX, intakeEditable, renderFindOrder, renderFindOrderSent, renderOrderPage } from '../views/order.js';
import { findTier } from '../views/ship.js';

const HOUR = 60 * 60 * 1000;
const ORDER_ID_RE = /^sl_[0-9a-f]{16}$/;
/** Compared against when the order does not exist, so both misses cost the same. */
const NO_TOKEN = 'x'.repeat(43);
export const MESSAGES_PER_HOUR = 10;
/** One links email per address in this window, however often it is requested. */
const FIND_REPEAT_MS = 10 * 60 * 1000;

export function registerClientRoutes(ctx: RouteContext): void {
  const { app, store, config, now, notifier, outbox, limiters } = ctx;
  const team = config.notifyEmail;

  app.use('/o/*', async (c, next) => {
    privateHeaders(c);
    await next();
  });
  app.use('/o/*', smallFormLimit);
  app.use('/orders/find', smallFormLimit);

  const notFound = (c: Context) => c.html(renderError(404, 'Order not found', 'This link is not valid. Use "Find my order" to get your link emailed again.'), 404);
  const tooMany = (c: Context, retryAfterSec: number, what: string) => {
    c.header('Retry-After', String(retryAfterSec));
    return c.html(renderError(429, 'Too many requests', `${what} Try again in ${Math.ceil(retryAfterSec / 60)} min.`), 429);
  };

  /** Resolves `/o/:orderId/:token`. Unknown id and wrong token are indistinguishable (same 404, same work). */
  function lookup(c: Context): OrderRow | Response {
    const key = `order:${clientIp(c)}`;
    const gate = limiters.orderLookup.check(key);
    if (!gate.allowed) return tooMany(c, gate.retryAfterSec, 'Too many invalid order links from this network.');
    const id = c.req.param('orderId') ?? '';
    const token = c.req.param('token') ?? '';
    const order = ORDER_ID_RE.test(id) ? store.getOrder(id) : undefined;
    const matches = safeEqual(token, order?.access_token || NO_TOKEN);
    if (!order || !order.access_token || !matches) {
      limiters.orderLookup.hit(key);
      return notFound(c);
    }
    return order;
  }

  function renderPage(c: Context, order: OrderRow, extra: { intakeValues?: IntakeFormValues; intakeErrors?: IntakeErrors; messageDraft?: string; messageError?: string; done?: string } = {}, status: 200 | 400 | 429 = 200) {
    const intake = parseIntake(order.intake_json);
    return c.html(
      renderOrderPage({
        order,
        tier: findTier(order.plan),
        events: store.listOrderEvents(order.id, 'client'),
        intake,
        intakeValues: extra.intakeValues ?? (intake ? intakeToFormValues(intake) : defaultIntakeValues(order.plan)),
        intakeErrors: extra.intakeErrors,
        messageDraft: extra.messageDraft,
        messageError: extra.messageError,
        done: extra.done,
        team,
      }),
      status,
    );
  }

  const pagePath = (o: OrderRow) => `/o/${o.id}/${o.access_token}`;

  app.get('/o/:orderId/:token', (c) => {
    const order = lookup(c);
    if (order instanceof Response) return order;
    const done = c.req.query('done');
    return renderPage(c, order, { done: done === 'intake' || done === 'message' ? done : undefined });
  });

  app.post('/o/:orderId/:token/intake', async (c) => {
    const order = lookup(c);
    if (order instanceof Response) return order;
    if (!intakeEditable(order)) return c.redirect(`${pagePath(order)}#intake`, 303);
    const gate = limiters.intake.hit(`intake:${order.id}`);
    if (!gate.allowed) return tooMany(c, gate.retryAfterSec, 'The intake was saved many times in a short while.');

    const result = validateIntake(await readForm(c), { team });
    if (!result.ok) return renderPage(c, order, { intakeValues: result.values, intakeErrors: result.errors }, 400);

    const updated = Boolean(order.intake_json);
    store.saveIntake(order.id, JSON.stringify(result.intake));
    if (order.stage === 'paid') store.setOrderStage(order.id, 'intake_received');
    store.addOrderEvent({ order_id: order.id, actor: 'client', type: 'intake', visibility: 'client', body: updated ? 'Intake updated.' : 'Intake submitted.' });
    notifier.intakeSubmitted(store.getOrder(order.id) ?? order, result.intake, updated);
    return c.redirect(`${pagePath(order)}?done=intake#intake`, 303);
  });

  app.post('/o/:orderId/:token/message', async (c) => {
    const order = lookup(c);
    if (order instanceof Response) return order;
    if (order.status !== 'paid') return c.redirect(pagePath(order), 303);

    const body = await readForm(c);
    const raw = typeof body.message === 'string' ? body.message.replace(/\r\n/g, '\n').trim() : '';
    const fail = (messageError: string, status: 400 | 429 = 400) => renderPage(c, order, { messageDraft: raw.slice(0, MESSAGE_MAX), messageError }, status);
    if (!raw) return fail('Write a message first.');
    if (raw.length > MESSAGE_MAX) return fail(`Messages are limited to ${MESSAGE_MAX} characters. Shorten it, or split it in two.`);
    const secret = findSecret(raw);
    if (secret) return fail(secretMessage(secret, team));
    if (store.countOrderEvents(order.id, 'client', 'message', now() - HOUR) >= MESSAGES_PER_HOUR) {
      c.header('Retry-After', '900');
      return fail(`That is ${MESSAGES_PER_HOUR} messages in an hour. We have them all; give us a moment to answer before sending more.`, 429);
    }

    store.addOrderEvent({ order_id: order.id, actor: 'client', type: 'message', visibility: 'client', body: raw });
    notifier.clientMessage(order, raw);
    return c.redirect(`${pagePath(order)}?done=message#updates`, 303);
  });

  // ---- find my order -------------------------------------------------------

  app.get('/orders/find', (c) => {
    c.header('X-Robots-Tag', 'noindex');
    return c.html(renderFindOrder({ emailEnabled: outbox.configured, team }));
  });

  app.post('/orders/find', async (c) => {
    c.header('X-Robots-Tag', 'noindex');
    c.header('Cache-Control', 'no-store');
    if (!outbox.configured) return c.html(renderFindOrder({ emailEnabled: false, team }));
    const gate = limiters.find.hit(`find:${clientIp(c)}`);
    if (!gate.allowed) return tooMany(c, gate.retryAfterSec, 'Too many link requests from this network.');

    const body = await readForm(c);
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
    if (typeof body.website === 'string' && body.website.trim()) return c.html(renderFindOrderSent()); // honeypot
    if (!EMAIL_RE.test(email)) return c.html(renderFindOrder({ emailEnabled: true, team, value: email, error: 'Enter a valid email address.' }), 400);

    // Same response whether or not the address has orders: the answer only ever arrives by email.
    const orders = store.findPaidOrdersByEmail(email);
    const to = orders[0]?.email; // the stored spelling of the address, never the typed one
    if (to && !notifier.recentlySentLinks(to, FIND_REPEAT_MS)) notifier.orderLinks(to, orders);
    return c.html(renderFindOrderSent());
  });
}
