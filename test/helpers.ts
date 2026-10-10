import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import type { EmailRow, OrderRow } from '../src/db.js';
import { Outbox } from '../src/mailer.js';
import type { MailMessage, MailTransport } from '../src/mailer.js';
import { createRateLimiter } from '../src/ratelimit.js';
import { stubScan } from '../src/scanner.js';
import type { Scanner } from '../src/scanner.js';

export const HOUR = 60 * 60 * 1000;
export const MINUTE = 60 * 1000;
export const START = Date.UTC(2026, 9, 10, 12, 0, 0);
export const FLW_API = 'https://flw.test/v3';
export const TEAM = 'developers@embracetech.org';
export const ADMIN_PASSWORD = 'correct horse battery staple';

/** Records what would have been sent; `failNext(n)` makes the next n sends throw like a flaky SMTP server. */
export function fakeTransport() {
  const sent: MailMessage[] = [];
  let failures = 0;
  const transport: MailTransport = {
    async send(message) {
      if (failures > 0) {
        failures--;
        throw Object.assign(new Error('451 4.3.0 Temporary failure, try again later'), { code: 'EENVELOPE', responseCode: 451 });
      }
      sent.push(message);
    },
  };
  return { sent, transport, failNext: (n: number) => void (failures = n) };
}

export interface HarnessOptions {
  env?: Record<string, string>;
  /** false: no transport, like a server without SMTP settings. */
  mail?: boolean;
  /** Amount the mock provider reports for a verified payment (major units). Defaults to whatever the order asks. */
  verified?: (txRef: string, id: string) => Record<string, unknown> | null;
}

/**
 * App with an in-memory database, a controllable clock, a fake mail transport and a mock
 * Flutterwave v3 API that verifies every payment as successful for the plan's price.
 */
export function harness(opts: HarnessOptions = {}) {
  let clock = START;
  const now = () => clock;
  const advance = (ms: number) => void (clock += ms);
  const config = loadConfig({
    FLW_SECRET_KEY: 'FLWSECK_TEST-not-a-real-key',
    FLW_WEBHOOK_HASH: 'whsec-test-hash',
    FLW_API_BASE: FLW_API,
    PUBLIC_URL: 'https://storelint.example',
    ADMIN_TOKEN: 'adm1n',
    ADMIN_PASSWORD,
    ...opts.env,
  });
  const store = new Store(':memory:', now);
  const scanner: Scanner = { scan: stubScan, available: false, source: 'stub' };
  const limiter = createRateLimiter({ ...config.rateLimit, now });
  const mail = fakeTransport();
  const outbox = new Outbox({
    store,
    now,
    from: { name: config.smtp.fromName, address: config.smtp.from ?? 'no-reply@storelint.example' },
    transport: opts.mail === false ? undefined : mail.transport,
    log: () => {},
  });

  // Mock provider: POST /payments hands out an id, GET /transactions/:id/verify reports it as paid in full.
  const refs = new Map<string, { txRef: string; amount: number; email: string }>();
  let nextId = 900_001;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST' && url === `${FLW_API}/payments`) {
      const body = JSON.parse(String(init.body)) as { tx_ref: string; amount: number; customer: { email: string } };
      const id = String(nextId++);
      refs.set(id, { txRef: body.tx_ref, amount: body.amount, email: body.customer.email });
      return json({ status: 'success', data: { link: `https://checkout.flutterwave.com/v3/hosted/pay/x?id=${id}` } });
    }
    const m = /\/transactions\/([^/]+)\/verify$/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1] ?? '');
      const ref = refs.get(id);
      if (!ref) return json({ status: 'error', message: 'No transaction was found for this id', data: null }, 400);
      const data = opts.verified
        ? opts.verified(ref.txRef, id)
        : { id: Number(id), tx_ref: ref.txRef, status: 'successful', amount: ref.amount, charged_amount: ref.amount, currency: 'USD', customer: { email: ref.email } };
      return data ? json({ status: 'success', data }) : json({ status: 'error', message: 'unavailable', data: null }, 400);
    }
    return json({ status: 'error', message: 'No route' }, 404);
  };

  const app = createApp({ store, config, scanner, limiter, now, fetch: fetchImpl, outbox });

  /** Everything recorded in the outbox, oldest first. */
  const emails = (): EmailRow[] => store.listEmails({ limit: 1000 }).reverse();
  const emailsOf = (kind: string): EmailRow[] => emails().filter((e) => e.kind === kind);

  /** Our order id behind a provider transaction id. */
  const txRefOf = (flwId: string): string => refs.get(flwId)?.txRef ?? '';

  return { app, store, config, outbox, now, advance, sent: mail.sent, failNext: mail.failNext, emails, emailsOf, txRefOf, flush: () => outbox.flush() };
}

export type Harness = ReturnType<typeof harness>;

export function form(fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

/** Runs a checkout to the point where the provider redirects back, without returning yet. */
export async function startCheckout(h: Harness, plan = 'play', email = 'ada@example.com'): Promise<{ order: OrderRow; flwId: string; payCookie: string }> {
  const res = await h.app.request(`/pay/${plan}`, form({ email, website: '' }));
  assert.equal(res.status, 303, await res.text());
  const flwId = new URL(res.headers.get('location') ?? '').searchParams.get('id') ?? '';
  const order = h.store.getOrder(h.txRefOf(flwId));
  assert.ok(order);
  const payCookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { order, flwId, payCookie };
}

/** Checkout + verified return. Resolves with the paid order and its private page path. */
export async function payOrder(h: Harness, plan = 'play', email = 'ada@example.com'): Promise<{ order: OrderRow; page: string }> {
  const { order, flwId } = await startCheckout(h, plan, email);
  const res = await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
  assert.equal(res.status, 303, await res.text());
  const paid = h.store.getOrder(order.id);
  assert.ok(paid);
  assert.equal(paid.status, 'paid');
  return { order: paid, page: `/o/${paid.id}/${paid.access_token}` };
}

export interface AdminSession {
  cookie: string;
  csrf: string;
  get(path: string): Promise<Response>;
  post(path: string, fields?: Record<string, string>): Promise<Response>;
}

/** Signs in through the real login form and returns helpers that carry the cookie and CSRF token. */
export async function login(h: Harness, password = ADMIN_PASSWORD, ip = '198.51.100.20'): Promise<AdminSession> {
  const res = await h.app.request('/admin/login', form({ password }, { 'x-forwarded-for': ip }));
  assert.equal(res.status, 303, `login should redirect, got ${res.status}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.match(cookie, /^sl_admin=[A-Za-z0-9_-]{43}$/);
  const dash = await h.app.request('/admin', { headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await dash.text())?.[1] ?? '';
  assert.ok(csrf, 'dashboard carries a CSRF token');
  return {
    cookie,
    csrf,
    get: (path) => Promise.resolve(h.app.request(path, { headers: { cookie } })),
    post: (path, fields = {}) => Promise.resolve(h.app.request(path, form({ _csrf: csrf, ...fields }, { cookie }))),
  };
}

export const VALID_INTAKE = {
  app_name: 'Pocket Ledger',
  framework: 'flutter',
  platform_android: '1',
  code_share: 'github',
  repo_url: 'https://github.com/ada/pocket-ledger',
  store_urls: 'https://play.google.com/store/apps/details?id=com.ada.ledger',
  play_account: 'yes',
  apple_account: 'na',
  target_date: '2026-11-30',
  notes: 'Flutter 3.35, internal track first.',
};
