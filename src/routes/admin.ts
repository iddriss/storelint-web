/**
 * Admin console: password login with server-side sessions, the dashboard, order and lead
 * pages with their actions, the email log, and a bearer-token JSON API for automation.
 *
 * - HTML pages need the `sl_admin` session cookie; every POST also needs the session's CSRF token.
 * - `/admin/api/*` needs `Authorization: Bearer <ADMIN_TOKEN>`. Tokens in query strings are never read.
 */
import type { Context } from 'hono';
import { isDeliverableEmail, isPlaceholderEmail } from '../addresses.js';
import {
  SESSION_COOKIE,
  SESSION_ID_RE,
  SESSION_TOUCH_MS,
  SESSION_TTL_MS,
  adminLoginMode,
  bearerToken,
  checkAdminPassword,
  clearSessionCookie,
  csrfToken,
  hashSessionId,
  newSessionId,
  readCookie,
  safeEqual,
  sessionCookie,
} from '../auth.js';
import type { LeadStatus, OrderRow } from '../db.js';
import { EMAIL_STATUSES, LEAD_STATUSES, ORDER_STATUSES } from '../db.js';
import { clientOrderUrl } from '../emails.js';
import type { RouteContext } from '../http.js';
import { clientIp, formText, privateHeaders, readForm, smallFormLimit } from '../http.js';
import { parseIntake } from '../intake-form.js';
import type { OrderStage } from '../stages.js';
import { ORDER_STAGES, STAGE_HEADLINES, isOrderStage } from '../stages.js';
import type { AdminTab } from '../views/admin.js';
import { ADMIN_TABS, renderAdminDisabled, renderAdminEmail, renderAdminLead, renderAdminLogin, renderAdminOrder, renderDashboard } from '../views/admin.js';
import { renderError } from '../views/html.js';

const DAY = 24 * 60 * 60 * 1000;
const ORDER_ID_RE = /^sl_[0-9a-f]{16}$/;

interface Session {
  id: string;
  csrf: string;
}

export function registerAdminRoutes(ctx: RouteContext): void {
  const { app, store, config, now, notifier, outbox, limiters } = ctx;
  const emailCtx = { publicUrl: config.publicUrl, team: config.notifyEmail };

  app.use('/admin', async (c, next) => {
    privateHeaders(c);
    await next();
  });
  app.use('/admin/*', async (c, next) => {
    privateHeaders(c);
    await next();
  });
  app.use('/admin/*', smallFormLimit);

  // ---- sessions ------------------------------------------------------------

  /** Resolves the session cookie, sliding its 12-hour expiry forward on use. */
  function currentSession(c: Context): Session | undefined {
    const id = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    if (!id || !SESSION_ID_RE.test(id)) return undefined;
    const hash = hashSessionId(id);
    const row = store.getSession(hash);
    if (!row) return undefined;
    if (now() - row.last_seen >= SESSION_TOUCH_MS) {
      store.extendSession(hash, now() + SESSION_TTL_MS);
      c.header('Set-Cookie', sessionCookie(id));
    }
    return { id, csrf: csrfToken(id) };
  }

  type Handler = (c: Context, s: Session) => Response | Promise<Response>;
  type PostHandler = (c: Context, s: Session, body: Record<string, unknown>) => Response | Promise<Response>;

  /** GET pages: no session sends the browser to the login page. */
  const page = (handler: Handler) => (c: Context) => {
    const s = currentSession(c);
    return s ? handler(c, s) : c.redirect('/admin', 303);
  };

  /** POST actions: session plus a matching CSRF token, or nothing happens. */
  const action = (handler: PostHandler) => async (c: Context) => {
    const s = currentSession(c);
    if (!s) return c.redirect('/admin', 303);
    const body = await readForm(c);
    const token = typeof body._csrf === 'string' ? body._csrf : '';
    if (!token || !safeEqual(token, s.csrf)) {
      return c.html(renderError(403, 'Session check failed', 'This form is out of date or did not come from the admin console. Go back, reload the page and try again.'), 403);
    }
    return handler(c, s, body);
  };

  const back = (c: Context, path: string, flash: string) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}flash=${flash}`, 303);

  // ---- login / logout ------------------------------------------------------

  app.get('/admin', (c) => {
    const s = currentSession(c);
    if (s) return dashboard(c, s);
    if (adminLoginMode(config) === 'disabled') return c.html(renderAdminDisabled(), 503);
    return c.html(renderAdminLogin({ flash: c.req.query('flash') === 'signed-out' ? 'signed-out' : undefined }));
  });

  app.post('/admin/login', async (c) => {
    if (adminLoginMode(config) === 'disabled') return c.html(renderAdminDisabled(), 503);
    const key = `login:${clientIp(c)}`;
    const gate = limiters.login.check(key);
    if (!gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSec));
      return c.html(renderAdminLogin({ error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} min.` }), 429);
    }
    const body = await readForm(c);
    const password = typeof body.password === 'string' ? body.password : '';
    const ok = password.length > 0 && password.length <= 1024 && (await checkAdminPassword(config, password));
    if (!ok) {
      limiters.login.hit(key);
      console.warn(`[admin] failed sign-in from ${clientIp(c)}`);
      return c.html(renderAdminLogin({ error: 'Sign-in failed. Check the password and try again.' }), 401);
    }
    store.deleteExpiredSessions();
    const id = newSessionId();
    store.insertSession(hashSessionId(id), now() + SESSION_TTL_MS, clientIp(c));
    c.header('Set-Cookie', sessionCookie(id));
    console.log(`[admin] sign-in from ${clientIp(c)}`);
    return c.redirect('/admin', 303);
  });

  app.post(
    '/admin/logout',
    action((c, s) => {
      store.deleteSession(hashSessionId(s.id));
      c.header('Set-Cookie', clearSessionCookie());
      return c.redirect('/admin?flash=signed-out', 303);
    }),
  );

  // ---- dashboard -----------------------------------------------------------

  function dashboard(c: Context, s: Session): Response | Promise<Response> {
    const rawTab = c.req.query('tab') ?? 'orders';
    const tab: AdminTab = (ADMIN_TABS as readonly string[]).includes(rawTab) ? (rawTab as AdminTab) : 'orders';
    const q = (c.req.query('q') ?? '').trim().slice(0, 120);
    const rawStatus = c.req.query('status') ?? '';
    const allowed: readonly string[] = tab === 'orders' ? ORDER_STATUSES : tab === 'leads' ? LEAD_STATUSES : tab === 'emails' ? EMAIL_STATUSES : [];
    const status = allowed.includes(rawStatus) ? rawStatus : '';
    const rawStage = c.req.query('stage') ?? '';
    const stage = tab === 'orders' && (rawStage === 'open' || (ORDER_STAGES as readonly string[]).includes(rawStage)) ? rawStage : '';
    const t = new Date(now());
    const monthStart = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
    const counts = store.dashboardCounts();

    return c.html(
      renderDashboard({
        csrf: s.csrf,
        tab,
        status,
        stage,
        q,
        flash: c.req.query('flash'),
        counts,
        revenueMonth: store.revenue(monthStart),
        revenueAll: store.revenue(),
        attention: {
          intakeOverdue: store.ordersAwaitingIntake(DAY),
          leadsOverdue: store.leadsAwaitingReply(DAY),
          failedEmails: store.listEmails({ status: 'failed', limit: 20 }),
          awaitingReply: store.ordersAwaitingReply(),
        },
        orders: tab === 'orders' ? store.searchOrders({ status, stage, q }) : [],
        leads: tab === 'leads' ? store.searchLeads({ waitlist: false, status, q }) : tab === 'waitlist' ? store.searchLeads({ waitlist: true, q }) : [],
        emails: tab === 'emails' ? store.listEmails({ status, q }) : [],
        totals: { orders: counts.orders, leads: counts.leads, waitlist: counts.waitlist, emails: counts.emails },
        smtp: { configured: outbox.configured, host: config.smtp.host, port: config.smtp.port },
        notifyEmail: config.notifyEmail,
        paymentsEnabled: ctx.checkoutOn,
      }),
    );
  }

  app.post(
    '/admin/test-email',
    action((c) => {
      const row = notifier.test();
      return back(c, '/admin?tab=emails', row && row.status === 'queued' ? 'test-queued' : 'test-skipped');
    }),
  );

  // The old JSON endpoints took ?token=. That token is no longer read anywhere.
  for (const legacy of ['leads', 'orders'] as const) {
    app.get(`/admin/${legacy}`, (c) => {
      if (c.req.query('token') !== undefined) {
        return c.json({ error: `Query tokens are no longer accepted. Use GET /admin/api/${legacy} with an "Authorization: Bearer" header.` }, 401);
      }
      return currentSession(c) ? c.redirect(`/admin?tab=${legacy}`, 303) : c.redirect('/admin', 303);
    });
  }

  // ---- orders --------------------------------------------------------------

  const orderParam = (c: Context): OrderRow | undefined => {
    const id = c.req.param('id') ?? '';
    return ORDER_ID_RE.test(id) ? store.getOrder(id) : undefined;
  };
  const noOrder = (c: Context) => c.html(renderError(404, 'Order not found', 'There is no order with that id.'), 404);
  const orderPath = (o: OrderRow) => `/admin/orders/${o.id}`;

  app.get(
    '/admin/orders/:id',
    page((c, s) => {
      const order = orderParam(c);
      if (!order) return noOrder(c);
      return c.html(
        renderAdminOrder({
          csrf: s.csrf,
          order,
          events: store.listOrderEvents(order.id),
          intake: parseIntake(order.intake_json),
          emails: store.listEmails({ q: order.id, limit: 30 }).filter((e) => e.related_type === 'order' && e.related_id === order.id),
          clientUrl: clientOrderUrl(emailCtx, order),
          flash: c.req.query('flash'),
        }),
      );
    }),
  );

  /** Applies a stage with its timeline entry and client email. `text` is the reason or an optional note. */
  function moveStage(order: OrderRow, stage: OrderStage, text: string): { emailed: boolean } {
    const updated = store.setOrderStage(order.id, stage, text) ?? order;
    store.addOrderEvent({ order_id: order.id, actor: 'admin', type: 'stage', visibility: 'client', body: text ? `${STAGE_HEADLINES[stage]}\n${text}` : STAGE_HEADLINES[stage] });
    return { emailed: notifier.clientUpdate(updated, { stage, text: text || undefined })?.status === 'queued' };
  }

  app.post(
    '/admin/orders/:id/stage',
    action((c, _s, body) => {
      const order = orderParam(c);
      if (!order) return noOrder(c);
      if (order.status !== 'paid') return back(c, orderPath(order), 'not-paid');
      const stage = formText(body, 'stage', 32);
      const text = formText(body, 'reason', 2000);
      if (!isOrderStage(stage)) return back(c, orderPath(order), 'stage-invalid');
      if (stage === 'needs_client' && !text) return back(c, orderPath(order), 'reason-required');
      if (stage === order.stage && (stage !== 'needs_client' || text === order.needs_client_reason)) return back(c, orderPath(order), 'stage-same');
      const { emailed } = moveStage(order, stage, text);
      return back(c, orderPath(order), emailed ? 'stage-set' : 'stage-set-noemail');
    }),
  );

  app.post(
    '/admin/orders/:id/update',
    action((c, _s, body) => {
      const order = orderParam(c);
      if (!order) return noOrder(c);
      if (order.status !== 'paid') return back(c, orderPath(order), 'not-paid');
      const text = formText(body, 'body', 4000);
      if (!text) return back(c, orderPath(order), 'empty');
      store.addOrderEvent({ order_id: order.id, actor: 'admin', type: 'update', visibility: 'client', body: text });
      const emailed = notifier.clientUpdate(order, { text })?.status === 'queued';
      return back(c, orderPath(order), emailed ? 'update-posted' : 'update-posted-noemail');
    }),
  );

  app.post(
    '/admin/orders/:id/note',
    action((c, _s, body) => {
      const order = orderParam(c);
      if (!order) return noOrder(c);
      const text = formText(body, 'body', 4000);
      if (!text) return back(c, orderPath(order), 'empty');
      // Internal: stored on the timeline for the team only. No email, never on the client page.
      store.addOrderEvent({ order_id: order.id, actor: 'admin', type: 'note', visibility: 'internal', body: text });
      return back(c, orderPath(order), 'note-added');
    }),
  );

  app.post(
    '/admin/orders/:id/resend-link',
    action((c) => {
      const order = orderParam(c);
      if (!order) return noOrder(c);
      if (order.status !== 'paid') return back(c, orderPath(order), 'not-paid');
      if (!isDeliverableEmail(order.email)) return back(c, orderPath(order), 'no-email');
      const row = notifier.orderLinks(order.email, [order]);
      store.addOrderEvent({ order_id: order.id, actor: 'admin', type: 'link', visibility: 'internal', body: `Order link emailed to ${order.email}${row ? ` (${row.status})` : ' (not recorded)'}.` });
      return back(c, orderPath(order), row?.status === 'queued' ? 'link-sent' : 'link-skipped');
    }),
  );

  app.post(
    '/admin/orders/:id/email',
    action((c, _s, body) => {
      const order = orderParam(c);
      if (!order) return noOrder(c);
      if (order.email && !isPlaceholderEmail(order.email)) return back(c, orderPath(order), 'email-locked');
      const email = formText(body, 'email', 254);
      if (!isDeliverableEmail(email)) return back(c, orderPath(order), 'email-invalid');
      store.setOrderEmail(order.id, email);
      store.addOrderEvent({ order_id: order.id, actor: 'admin', type: 'email', visibility: 'internal', body: `Client email set to ${email}.` });
      return back(c, orderPath(order), 'email-saved');
    }),
  );

  app.post(
    '/admin/orders/:id/cancel',
    action((c, _s, body) => {
      const order = orderParam(c);
      if (!order) return noOrder(c);
      if (order.status !== 'paid') return back(c, orderPath(order), 'not-paid');
      const refunded = Boolean(body.refunded);
      const reason = formText(body, 'reason', 1000);
      const text = [reason, refunded ? 'A refund was issued outside this page. It can take a few days to reach your account.' : ''].filter(Boolean).join('\n');
      if (refunded) store.markOrderRefunded(order.id);
      if (order.stage === 'cancelled') {
        if (refunded) store.addOrderEvent({ order_id: order.id, actor: 'admin', type: 'cancelled', visibility: 'internal', body: 'Marked refunded externally.' });
        return back(c, orderPath(order), 'cancelled');
      }
      moveStage(order, 'cancelled', text);
      return back(c, orderPath(order), 'cancelled');
    }),
  );

  // ---- leads ---------------------------------------------------------------

  const leadParam = (c: Context) => {
    const id = c.req.param('id') ?? '';
    return /^\d{1,12}$/.test(id) ? store.getLead(Number(id)) : undefined;
  };
  const noLead = (c: Context) => c.html(renderError(404, 'Lead not found', 'There is no lead with that id.'), 404);

  app.get(
    '/admin/leads/:id',
    page((c, s) => {
      const lead = leadParam(c);
      if (!lead) return noLead(c);
      return c.html(renderAdminLead({ csrf: s.csrf, lead, publicUrl: config.publicUrl, flash: c.req.query('flash') }));
    }),
  );

  app.post(
    '/admin/leads/:id',
    action((c, _s, body) => {
      const lead = leadParam(c);
      if (!lead) return noLead(c);
      const status = formText(body, 'status', 16);
      store.updateLead(lead.id, {
        status: (LEAD_STATUSES as readonly string[]).includes(status) ? (status as LeadStatus) : undefined,
        notes: typeof body.notes === 'string' ? formText(body, 'notes', 5000) : undefined,
      });
      return back(c, `/admin/leads/${lead.id}`, 'lead-saved');
    }),
  );

  // ---- email log -----------------------------------------------------------

  const emailParam = (c: Context) => {
    const id = c.req.param('id') ?? '';
    return /^\d{1,12}$/.test(id) ? store.getEmail(Number(id)) : undefined;
  };
  const noEmail = (c: Context) => c.html(renderError(404, 'Email not found', 'There is no outbox entry with that id.'), 404);

  app.get(
    '/admin/emails/:id',
    page((c, s) => {
      const email = emailParam(c);
      if (!email) return noEmail(c);
      return c.html(renderAdminEmail({ csrf: s.csrf, email, flash: c.req.query('flash') }));
    }),
  );

  app.post(
    '/admin/emails/:id/retry',
    action((c) => {
      const email = emailParam(c);
      if (!email) return noEmail(c);
      store.requeueEmail(email.id);
      outbox.kick();
      return back(c, `/admin/emails/${email.id}`, 'retry-queued');
    }),
  );

  // ---- JSON API for automation (bearer header only) ------------------------

  const api = (handler: (c: Context) => Response) => (c: Context) => {
    const presented = bearerToken(c.req.header('authorization'));
    if (!config.adminToken || !presented || !safeEqual(presented, config.adminToken)) {
      c.header('WWW-Authenticate', 'Bearer realm="storelint-admin"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    return handler(c);
  };
  const isoTime = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

  app.get(
    '/admin/api/leads',
    api((c) => {
      const leads = store.listLeads().map((l) => ({ ...l, created_at: isoTime(l.created_at), updated_at: isoTime(l.updated_at) }));
      return c.json({ count: leads.length, leads });
    }),
  );

  app.get(
    '/admin/api/orders',
    api((c) => {
      const orders = store.listOrders().map(({ access_token: _token, ...o }) => ({
        ...o,
        created_at: isoTime(o.created_at),
        updated_at: isoTime(o.updated_at),
        paid_at: isoTime(o.paid_at),
        intake_at: isoTime(o.intake_at),
        refunded_at: isoTime(o.refunded_at),
        intake: parseIntake(o.intake_json) ?? null,
        admin_url: `${config.publicUrl}/admin/orders/${o.id}`,
      }));
      return c.json({ count: orders.length, orders });
    }),
  );

  app.get(
    '/admin/api/summary',
    api((c) => {
      const t = new Date(now());
      const counts = store.dashboardCounts();
      return c.json({
        generated_at: t.toISOString(),
        leads: { new: counts.newLeads, waitlist: counts.waitlist },
        orders: { awaiting_intake: counts.awaitingIntake, in_progress: counts.inProgress, live: counts.live },
        revenue: { this_month: store.revenue(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)), all_time: store.revenue() },
        attention: {
          intake_overdue: store.ordersAwaitingIntake(DAY).map((o) => o.id),
          leads_overdue: store.leadsAwaitingReply(DAY).map((l) => l.id),
          client_messages_unanswered: store.ordersAwaitingReply().map((o) => o.id),
          failed_emails: store.countEmails('failed'),
        },
        email: { configured: outbox.configured, queued: store.countEmails('queued'), failed: store.countEmails('failed'), skipped: store.countEmails('skipped') },
      });
    }),
  );
}
