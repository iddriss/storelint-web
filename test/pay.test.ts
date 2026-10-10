import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { judgePayment } from '../src/flutterwave.js';
import { createRateLimiter } from '../src/ratelimit.js';
import { stubScan } from '../src/scanner.js';
import type { Scanner } from '../src/scanner.js';

const API = 'https://flw.test/v3';
const KEY = 'FLWSECK_TEST-not-a-real-key';
const HASH = 'whsec-test-hash';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

type Responder = (call: Call) => { status?: number; body: unknown } | undefined;

/** Records every call and answers from `responder`; unknown routes 404 like the real API would. */
function mockFetch(responder: Responder = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: Call = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const reply = responder(call) ?? { status: 404, body: { status: 'error', message: 'No route' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fetchImpl };
}

function harness(opts: { env?: Record<string, string>; responder?: Responder; payments?: boolean } = {}) {
  const now = () => Date.UTC(2026, 9, 10, 12, 0, 0);
  const payments = opts.payments ?? true;
  const config = loadConfig({
    ...(payments ? { FLW_SECRET_KEY: KEY, FLW_WEBHOOK_HASH: HASH, FLW_API_BASE: API } : {}),
    PUBLIC_URL: 'https://storelint.example',
    ADMIN_TOKEN: 'adm1n',
    ...opts.env,
  });
  const store = new Store(':memory:', now);
  const scanner: Scanner = { scan: stubScan, available: false, source: 'stub' };
  const limiter = createRateLimiter({ ...config.rateLimit, now });
  const mock = mockFetch(opts.responder);
  const app = createApp({ store, config, scanner, limiter, now, fetch: mock.fetch });
  return { app, store, config, calls: mock.calls };
}

function form(fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

const HOSTED = 'https://checkout.flutterwave.com/v3/hosted/pay/abc123';

/** Answers POST /payments with a hosted link and GET /transactions/:id/verify with `verified(txRef)`. */
function flwResponder(verified: (txRef: string, id: string) => Record<string, unknown> | null): Responder {
  const refs = new Map<string, string>(); // flw id -> tx_ref
  let nextId = 900_001;
  return (call) => {
    if (call.method === 'POST' && call.url === `${API}/payments`) {
      const id = String(nextId++);
      refs.set(id, String(call.body?.tx_ref));
      return { body: { status: 'success', message: 'Hosted Link', data: { link: `${HOSTED}?id=${id}` } } };
    }
    const m = /\/transactions\/([^/]+)\/verify$/.exec(call.url);
    if (call.method === 'GET' && m) {
      const id = decodeURIComponent(m[1] ?? '');
      const txRef = refs.get(id) ?? '';
      const data = verified(txRef, id);
      return data ? { body: { status: 'success', message: 'Transaction fetched successfully', data } } : { status: 400, body: { status: 'error', message: 'No transaction was found for this id', data: null } };
    }
    return undefined;
  };
}

const successful = (overrides: Record<string, unknown> = {}) => (txRef: string, id: string) => ({
  id: Number(id),
  tx_ref: txRef,
  flw_ref: 'FLW-MOCK-REF',
  status: 'successful',
  amount: 149,
  charged_amount: 149,
  currency: 'USD',
  customer: { email: 'ada@example.com', name: 'Ada' },
  ...overrides,
});

async function startOrder(h: ReturnType<typeof harness>, plan = 'play', email = 'ada@example.com') {
  const res = await h.app.request(`/pay/${plan}`, form({ email, website: '' }));
  assert.equal(res.status, 303, await res.text());
  const order = h.store.listOrders()[0];
  assert.ok(order);
  const flwId = new URL(res.headers.get('location') ?? '').searchParams.get('id') ?? '';
  return { order, flwId, location: res.headers.get('location') ?? '' };
}

describe('price card buttons', () => {
  it('scroll to the lead form when neither FLW_SECRET_KEY nor PAY_LINK_* is set', async () => {
    const { app } = harness({ payments: false });
    for (const path of ['/', '/ship']) {
      const html = await (await app.request(path)).text();
      assert.match(html, /href="\/ship\?plan=play#lead"/, path);
      assert.doesNotMatch(html, /action="\/pay\//, path);
    }
  });

  it('post to /pay/:plan on the landing page and /ship when FLW_SECRET_KEY is set', async () => {
    const { app } = harness();
    for (const path of ['/', '/ship']) {
      const html = await (await app.request(path)).text();
      for (const plan of ['play', 'ios', 'both', 'fix']) assert.match(html, new RegExp(`action="/pay/${plan}"`), `${path} ${plan}`);
      assert.match(html, /name="website" class="hp"/);
      assert.match(html, /Pay \$299 &amp; start/);
      assert.doesNotMatch(html, /href="\/ship\?plan=play#lead"/, path);
    }
  });

  it('prefer PAY_LINK_* over the hosted checkout form', async () => {
    const { app } = harness({ env: { PAY_LINK_BOTH: 'https://pay.example/both' } });
    const html = await (await app.request('/ship')).text();
    assert.match(html, /href="https:\/\/pay\.example\/both"/);
    assert.doesNotMatch(html, /action="\/pay\/both"/);
    assert.match(html, /action="\/pay\/play"/);
  });

  it('prefill the checkout email from the lead form on /ship', async () => {
    const { app } = harness();
    const res = await app.request('/ship', form({ name: 'Ada', email: 'ada@example.com', platform: 'mars' }));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /id="pay-email-play"[^>]*value="ada@example\.com"/);
  });
});

describe('POST /pay/:plan', () => {
  it('rejects unknown plans and is 404 when payments are off', async () => {
    const on = harness();
    assert.equal((await on.app.request('/pay/enterprise', form({}))).status, 404);
    assert.equal(on.store.listOrders().length, 0);
    const off = harness({ payments: false });
    assert.equal((await off.app.request('/pay/play', form({ email: 'a@b.co' }))).status, 404);
    assert.equal(off.calls.length, 0);
  });

  it('creates a pending order and redirects to the hosted link', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const res = await h.app.request('/pay/both', form({ email: 'ada@example.com' }, { 'x-forwarded-for': '203.0.113.9' }));
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', /^https:\/\/checkout\.flutterwave\.com\//);

    const [order] = h.store.listOrders();
    assert.ok(order);
    assert.equal(order.status, 'pending');
    assert.equal(order.plan, 'both');
    assert.equal(order.amount_cents, 29900);
    assert.equal(order.currency, 'USD');
    assert.equal(order.email, 'ada@example.com');
    assert.equal(order.tx_ref, order.id);
    assert.equal(order.flw_id, null);
    assert.equal(order.ip, '203.0.113.9');

    assert.equal(h.calls.length, 1);
    const call = h.calls[0]!;
    assert.equal(call.url, `${API}/payments`);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.body?.tx_ref, order.id);
    assert.equal(call.body?.amount, 299);
    assert.equal(call.body?.currency, 'USD');
    assert.equal(call.body?.redirect_url, 'https://storelint.example/pay/return');
    assert.deepEqual(call.body?.customer, { email: 'ada@example.com' });
    assert.deepEqual(call.body?.customizations, { title: 'StoreLint release ops', description: 'Both stores ($299)' });
  });

  it('uses a placeholder customer email when none is given', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const res = await h.app.request('/pay/fix', form({ email: 'not-an-email' }));
    assert.equal(res.status, 303);
    const order = h.store.listOrders()[0]!;
    assert.equal(order.email, '');
    assert.equal((h.calls[0]!.body?.customer as { email: string }).email, `orders+${order.id}@storelint.example`);
  });

  it('drops honeypot submissions without creating an order', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const res = await h.app.request('/pay/play', form({ email: 'bot@example.com', website: 'http://spam' }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ship');
    assert.equal(h.store.listOrders().length, 0);
    assert.equal(h.calls.length, 0);
  });

  it('renders an error page and marks the order failed when the API rejects the request', async () => {
    const h = harness({ responder: () => ({ status: 401, body: { status: 'error', message: 'Invalid authorization key' } }) });
    const res = await h.app.request('/pay/play', form({ email: 'ada@example.com' }));
    assert.equal(res.status, 502);
    const html = await res.text();
    assert.match(html, /couldn&rsquo;t open the payment page/);
    assert.match(html, /Invalid authorization key/);
    assert.match(html, /href="\/ship\?plan=play#lead"/);
    assert.equal(h.store.listOrders()[0]?.status, 'failed');
  });

  it('renders the error page when the API is unreachable', async () => {
    const h = harness({
      responder: () => {
        throw new TypeError('fetch failed');
      },
    });
    const res = await h.app.request('/pay/play', form({ email: 'ada@example.com' }));
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Could not reach Flutterwave/);
  });

  it('is rate limited per IP, independently of /scan', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const headers = { 'x-forwarded-for': '198.51.100.7' };
    for (let i = 0; i < 10; i++) assert.equal((await h.app.request('/api/scan', { method: 'POST', headers, body: new FormData() })).status, 400);
    assert.equal((await h.app.request('/api/scan', { method: 'POST', headers, body: new FormData() })).status, 429);
    for (let i = 0; i < 10; i++) assert.equal((await h.app.request('/pay/play', form({ email: 'a@b.co' }, headers))).status, 303);
    const blocked = await h.app.request('/pay/play', form({ email: 'a@b.co' }, headers));
    assert.equal(blocked.status, 429);
    assert.match(await blocked.text(), /checkout attempts/);
    assert.equal((await h.app.request('/pay/return?tx_ref=x', { headers })).status, 429);
  });

  it('GET /pay/:plan sends people to the pricing section', async () => {
    const { app } = harness();
    const res = await app.request('/pay/ios');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ship?plan=ios#prices');
  });
});

describe('GET /pay/return', () => {
  it('marks the order paid only after a successful server-side verification', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const { order, flwId } = await startOrder(h);
    const res = await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Payment received/);
    assert.match(html, /email you within 24 hours/);
    assert.match(html, /Intake checklist/);
    assert.match(html, /Repository access/);
    assert.match(html, /App Store Connect: invite us/);
    const paid = h.store.getOrder(order.id)!;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.flw_id, flwId);
    assert.match(paid.raw_json ?? '', /"status":"successful"/);
    const verify = h.calls[1]!;
    assert.equal(verify.url, `${API}/transactions/${flwId}/verify`);
    assert.equal(verify.headers.authorization, `Bearer ${KEY}`);
  });

  it('does not trust the query string: a mismatched amount is not paid', async () => {
    const h = harness({ responder: flwResponder(successful({ amount: 1, charged_amount: 1 })) });
    const { order, flwId } = await startOrder(h);
    const res = await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /did not go through/);
    assert.match(html, /amount 1 is below 149/);
    assert.match(html, /action="\/pay\/play"/);
    assert.equal(h.store.getOrder(order.id)?.status, 'failed');
  });

  it('a mismatched currency or tx_ref is not paid', async () => {
    const h1 = harness({ responder: flwResponder(successful({ currency: 'NGN' })) });
    const a = await startOrder(h1);
    await h1.app.request(`/pay/return?status=successful&tx_ref=${a.order.id}&transaction_id=${a.flwId}`);
    assert.equal(h1.store.getOrder(a.order.id)?.status, 'failed');

    const h2 = harness({ responder: flwResponder((_ref, id) => successful()('sl_0000000000000000', id)) });
    const b = await startOrder(h2);
    await h2.app.request(`/pay/return?status=successful&tx_ref=${b.order.id}&transaction_id=${b.flwId}`);
    assert.equal(h2.store.getOrder(b.order.id)?.status, 'failed');
  });

  it('a verify status other than successful is not paid even with status=successful in the query', async () => {
    const h = harness({ responder: flwResponder(successful({ status: 'failed' })) });
    const { order, flwId } = await startOrder(h);
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    assert.equal(h.store.getOrder(order.id)?.status, 'failed');
  });

  it('records a cancellation without calling the API', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const { order } = await startOrder(h);
    const res = await h.app.request(`/pay/return?status=cancelled&tx_ref=${order.id}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Payment cancelled/);
    assert.equal(h.store.getOrder(order.id)?.status, 'cancelled');
    assert.equal(h.calls.length, 1);
  });

  it('leaves the order pending when verification is temporarily unavailable', async () => {
    const h = harness({ responder: flwResponder(() => null) });
    const { order, flwId } = await startOrder(h);
    const res = await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    assert.match(await res.text(), /still pending/);
    assert.equal(h.store.getOrder(order.id)?.status, 'pending');
  });

  it('404s for unknown or malformed references', async () => {
    const { app } = harness();
    assert.equal((await app.request('/pay/return?status=successful&tx_ref=sl_0000000000000000&transaction_id=1')).status, 404);
    assert.equal((await app.request('/pay/return?tx_ref=../etc')).status, 404);
  });

  it('fills in the buyer email from the verified customer when the form left it empty', async () => {
    const h = harness({ responder: flwResponder(successful({ customer: { email: 'real@example.com' } })) });
    const { order, flwId } = await startOrder(h, 'play', '');
    assert.equal(order.email, '');
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    assert.equal(h.store.getOrder(order.id)?.email, 'real@example.com');
  });
});

describe('POST /webhooks/flutterwave', () => {
  const webhook = (body: unknown, hash?: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(hash === undefined ? {} : { 'verif-hash': hash }) },
    body: JSON.stringify(body),
  });
  const chargeCompleted = (order: { id: string }, flwId: string, extra: Record<string, unknown> = {}) => ({
    event: 'charge.completed',
    data: { id: Number(flwId), tx_ref: order.id, status: 'successful', amount: 149, currency: 'USD', customer: { email: 'ada@example.com' }, ...extra },
  });

  it('rejects a missing or wrong verif-hash with 401 and touches nothing', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const { order, flwId } = await startOrder(h);
    assert.equal((await h.app.request('/webhooks/flutterwave', webhook(chargeCompleted(order, flwId)))).status, 401);
    assert.equal((await h.app.request('/webhooks/flutterwave', webhook(chargeCompleted(order, flwId), 'nope'))).status, 401);
    assert.equal((await h.app.request('/webhooks/flutterwave', webhook(chargeCompleted(order, flwId), HASH + 'x'))).status, 401);
    assert.equal(h.store.getOrder(order.id)?.status, 'pending');
    assert.equal(h.calls.length, 1);
  });

  it('is locked when FLW_WEBHOOK_HASH is unset', async () => {
    const h = harness({ env: { FLW_WEBHOOK_HASH: '' } });
    assert.equal((await h.app.request('/webhooks/flutterwave', webhook({ event: 'charge.completed' }, ''))).status, 401);
    assert.equal((await h.app.request('/webhooks/flutterwave', webhook({ event: 'charge.completed' }, 'anything'))).status, 401);
  });

  it('re-verifies by id, marks the order paid, and is idempotent on replay', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const { order, flwId } = await startOrder(h);
    const res = await h.app.request('/webhooks/flutterwave', webhook(chargeCompleted(order, flwId), HASH));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, order: order.id, status: 'paid' });
    assert.equal(h.store.getOrder(order.id)?.status, 'paid');
    assert.equal(h.store.getOrder(order.id)?.flw_id, flwId);
    assert.equal(h.calls.filter((c) => c.url.endsWith('/verify')).length, 1);
    const updated = h.store.getOrder(order.id)!.updated_at;

    const replay = await h.app.request('/webhooks/flutterwave', webhook(chargeCompleted(order, flwId), HASH));
    assert.equal(replay.status, 200);
    assert.equal(h.calls.filter((c) => c.url.endsWith('/verify')).length, 1, 'no second verify call for a paid order');
    assert.equal(h.store.getOrder(order.id)?.status, 'paid');
    assert.equal(h.store.getOrder(order.id)?.updated_at, updated);

    // A later "failed" notification can never downgrade a paid order.
    const h2 = harness({ responder: flwResponder(successful({ status: 'failed' })) });
    const paid = h.store.getOrder(order.id)!;
    h2.store.insertOrder({ plan: paid.plan, amount_cents: paid.amount_cents, currency: paid.currency, email: paid.email, ip: '' });
    const o2 = h2.store.listOrders()[0]!;
    h2.store.updateOrder(o2.id, { status: 'paid', flw_id: '1' });
    const late = await h2.app.request('/webhooks/flutterwave', webhook(chargeCompleted(o2, '1'), HASH));
    assert.equal(late.status, 200);
    assert.equal(h2.store.getOrder(o2.id)?.status, 'paid');
  });

  it('trusts the verify response, not the webhook body', async () => {
    const h = harness({ responder: flwResponder(successful({ amount: 5 })) });
    const { order, flwId } = await startOrder(h);
    const res = await h.app.request('/webhooks/flutterwave', webhook(chargeCompleted(order, flwId), HASH));
    assert.equal(res.status, 200);
    assert.equal(h.store.getOrder(order.id)?.status, 'failed');
  });

  it('acknowledges other events and unknown orders without doing anything', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const other = await h.app.request('/webhooks/flutterwave', webhook({ event: 'transfer.completed', data: {} }, HASH));
    assert.equal(other.status, 200);
    const unknown = await h.app.request('/webhooks/flutterwave', webhook(chargeCompleted({ id: 'sl_ffffffffffffffff' }, '1'), HASH));
    assert.equal(unknown.status, 200);
    assert.equal((await h.app.request('/webhooks/flutterwave', { method: 'POST', headers: { 'verif-hash': HASH }, body: '{nope' })).status, 400);
    assert.equal(h.calls.length, 0);
  });
});

describe('admin', () => {
  it('GET /admin/orders returns orders as JSON behind the token', async () => {
    const h = harness({ responder: flwResponder(successful()) });
    const { order } = await startOrder(h);
    assert.equal((await h.app.request('/admin/orders')).status, 401);
    assert.equal((await h.app.request('/admin/orders?token=wrong')).status, 401);
    const res = await h.app.request('/admin/orders?token=adm1n');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { count: number; orders: Array<{ id: string; status: string; created_at: string }> };
    assert.equal(body.count, 1);
    assert.equal(body.orders[0]?.id, order.id);
    assert.equal(body.orders[0]?.status, 'pending');
    assert.match(body.orders[0]?.created_at ?? '', /^2026-10-10T12:00:00/);
  });

  it('GET /admin renders orders and leads together', async () => {
    const h = harness({ responder: flwResponder(successful({ amount: 299, charged_amount: 299 })) });
    const { order, flwId } = await startOrder(h, 'both');
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    h.store.insertLead({ name: 'Grace Hopper', email: 'grace@example.com', platform: 'ios', store_links: '', repo_url: '', message: 'hi', ip: '' });
    assert.equal((await h.app.request('/admin')).status, 401);
    const res = await h.app.request('/admin?token=adm1n');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /1 paid, \$299 collected/);
    assert.match(html, /status-paid/);
    assert.match(html, new RegExp(order.id));
    assert.match(html, /Grace Hopper/);
  });
});

describe('judgePayment', () => {
  const order = { tx_ref: 'sl_00', amount_cents: 14900, currency: 'USD' };
  const base = { id: 1, tx_ref: 'sl_00', status: 'successful', amount: 149, currency: 'USD' };
  it('accepts exact and overpaid, rejects everything else', () => {
    assert.deepEqual(judgePayment(order, base), { paid: true });
    assert.deepEqual(judgePayment(order, { ...base, amount: 150 }), { paid: true });
    assert.deepEqual(judgePayment(order, { ...base, currency: 'usd' }), { paid: true });
    assert.equal(judgePayment(order, { ...base, amount: 148.99 }).paid, false);
    assert.equal(judgePayment(order, { ...base, amount: Number.NaN }).paid, false);
    assert.equal(judgePayment(order, { ...base, status: 'pending' }).paid, false);
    assert.equal(judgePayment(order, { ...base, currency: 'GHS' }).paid, false);
    assert.equal(judgePayment(order, { ...base, tx_ref: 'sl_01' }).paid, false);
  });
});
