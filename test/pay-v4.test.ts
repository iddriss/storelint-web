import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { DEFAULT_FLW_API_BASE, DEFAULT_FLW_V4_API_BASE, loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { DEFAULT_FLW_V4_TOKEN_URL, normalizeV4Charge } from '../src/flutterwave.js';
import { createRateLimiter } from '../src/ratelimit.js';
import { stubScan } from '../src/scanner.js';
import type { Scanner } from '../src/scanner.js';

const API = 'https://flw4.test';
const TOKEN_URL = 'https://idp.test/realms/flutterwave/protocol/openid-connect/token';
const CLIENT_ID = 'FLWPUBK-not-a-real-client-id-X';
const CLIENT_SECRET = 'not-a-real-client-secret';
const HASH = 'whsec-v4-test-hash';
const HOSTED = 'https://checkout-v4.flutterwave.test/redirects';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  json: Record<string, unknown> | undefined;
  form: URLSearchParams | undefined;
}

type Reply = { status?: number; body: unknown } | undefined;
type Responder = (call: Call) => Reply;

function mockFetch(responder: Responder) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const ct = headers['content-type'] ?? '';
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers,
      json: raw && ct.includes('json') ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      form: raw && ct.includes('x-www-form-urlencoded') ? new URLSearchParams(raw) : undefined,
    };
    calls.push(call);
    const reply = responder(call) ?? { status: 404, body: { status: 'failed', error: { type: 'NOT_FOUND', code: '10404', message: 'No route' } } };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fetchImpl };
}

const V4_ENV = {
  FLW_CLIENT_ID: CLIENT_ID,
  FLW_CLIENT_SECRET: CLIENT_SECRET,
  FLW_WEBHOOK_HASH: HASH,
  FLW_API_BASE: API,
  FLW_TOKEN_URL: TOKEN_URL,
  FLW_V4_PAYMENT_METHOD: 'opay',
  PUBLIC_URL: 'https://storelint.example',
  ADMIN_TOKEN: 'adm1n',
};

function harness(opts: { env?: Record<string, string>; responder?: Responder } = {}) {
  const clock = { now: Date.UTC(2026, 9, 10, 12, 0, 0) };
  const now = () => clock.now;
  const config = loadConfig({ ...V4_ENV, ...opts.env });
  const store = new Store(':memory:', now);
  const scanner: Scanner = { scan: stubScan, available: false, source: 'stub' };
  const limiter = createRateLimiter({ ...config.rateLimit, now });
  const mock = mockFetch(opts.responder ?? v4Responder(succeeded()));
  const app = createApp({ store, config, scanner, limiter, now, fetch: mock.fetch });
  const tokenCalls = () => mock.calls.filter((c) => c.url === TOKEN_URL);
  const apiCalls = () => mock.calls.filter((c) => c.url.startsWith(API));
  return { app, store, config, calls: mock.calls, clock, tokenCalls, apiCalls };
}

function form(fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

interface ResponderOptions {
  /** `next_action` returned by the orchestrator (default: a redirect). */
  nextAction?: Record<string, unknown>;
  /** Token lifetime reported by the IdP. */
  expiresIn?: number;
  /** Tokens (by sequence number) the API rejects with 401. */
  rejectTokens?: number[];
  /** Make the IdP refuse the client. */
  tokenError?: boolean;
}

const UNAUTHORIZED = { status: 401, body: { status: 'failed', error: { type: 'UNAUTHORIZED', code: '10401', message: 'Unauthorized' } } };

/**
 * Mocks the v4 surface: the IdP token endpoint, POST /orchestration/direct-charges and GET /charges/:id.
 * `verified(reference, id)` is what GET /charges/:id returns for a charge created earlier.
 */
function v4Responder(verified: (reference: string, id: string) => Record<string, unknown> | null, opts: ResponderOptions = {}): Responder {
  const refs = new Map<string, string>(); // charge id -> reference
  let nextId = 1;
  let tokens = 0;
  return (call) => {
    if (call.url === TOKEN_URL) {
      if (opts.tokenError) return { status: 401, body: { error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials' } };
      tokens++;
      return { body: { access_token: `tok-${tokens}`, expires_in: opts.expiresIn ?? 600, refresh_expires_in: 0, token_type: 'Bearer', scope: 'profile email' } };
    }
    const auth = call.headers.authorization ?? '';
    const m = /^Bearer tok-(\d+)$/.exec(auth);
    if (!m || (opts.rejectTokens ?? []).includes(Number(m[1]))) return UNAUTHORIZED;
    if (call.method === 'POST' && call.url === `${API}/orchestration/direct-charges`) {
      const id = `chg_${String(nextId++).padStart(6, '0')}`;
      const reference = String(call.json?.reference);
      refs.set(id, reference);
      const nextAction = opts.nextAction ?? { type: 'redirect_url', redirect_url: { url: `${HOSTED}?opay&token=${id}` } };
      return {
        status: 201,
        body: {
          status: 'success',
          message: 'Charge created',
          data: { id, amount: call.json?.amount, currency: call.json?.currency, reference, status: 'pending', next_action: nextAction, payment_method_details: {} },
        },
      };
    }
    const g = new RegExp(`^${API}/charges/([^/?]+)$`).exec(call.url);
    if (call.method === 'GET' && g) {
      const id = decodeURIComponent(g[1] ?? '');
      const reference = refs.get(id);
      const data = reference === undefined ? null : verified(reference, id);
      return data
        ? { body: { status: 'success', message: 'Charge fetched', data } }
        : { status: 404, body: { status: 'failed', error: { type: 'NOT_FOUND', code: '10404', message: 'Charge not found' } } };
    }
    return undefined;
  };
}

const succeeded = (overrides: Record<string, unknown> = {}) => (reference: string, id: string) => ({
  id,
  amount: 149,
  currency: 'USD',
  reference,
  status: 'succeeded',
  customer: { id: 'cus_test', email: 'ada@example.com' },
  payment_method_details: { type: 'opay' },
  processor_response: { type: 'approved', code: '00' },
  created_datetime: '2026-10-10T12:00:00Z',
  ...overrides,
});

async function startOrder(h: ReturnType<typeof harness>, plan = 'play', email = 'ada@example.com') {
  const res = await h.app.request(`/pay/${plan}`, form({ email, website: '' }));
  assert.equal(res.status, 303, await res.text());
  const order = h.store.listOrders()[0];
  assert.ok(order);
  return { order, chargeId: order.flw_id ?? '', location: res.headers.get('location') ?? '' };
}

function sign(body: string, secret = HASH): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function v4Event(order: { id: string }, chargeId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'wbk_W5p6ktwU0jQ8RO4By860',
    timestamp: 1760097600000,
    type: 'charge.completed',
    data: { id: chargeId, reference: order.id, status: 'succeeded', amount: 149, currency: 'USD', customer: { id: 'cus_test', email: 'ada@example.com' }, ...overrides },
  });
}

function webhook(body: string, headers: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body };
}

describe('Flutterwave version detection', () => {
  it('stays on v3 with only FLW_SECRET_KEY', () => {
    const c = loadConfig({ FLW_SECRET_KEY: 'FLWSECK_TEST-x' });
    assert.equal(c.flutterwave.version, 'v3');
    assert.equal(c.flutterwave.secretKey, 'FLWSECK_TEST-x');
    assert.equal(c.flutterwave.clientId, undefined);
    assert.equal(c.flutterwave.apiBase, DEFAULT_FLW_API_BASE);
    assert.equal(c.flutterwave.configured, true);
    assert.equal(c.paymentsEnabled, true);
  });

  it('switches to v4 when FLW_CLIENT_ID is set and FLW_API_VERSION is not', () => {
    const c = loadConfig({ FLW_CLIENT_ID: CLIENT_ID, FLW_CLIENT_SECRET: CLIENT_SECRET });
    assert.equal(c.flutterwave.version, 'v4');
    assert.equal(c.flutterwave.clientId, CLIENT_ID);
    assert.equal(c.flutterwave.clientSecret, CLIENT_SECRET);
    assert.equal(c.flutterwave.secretKey, undefined);
    assert.equal(c.flutterwave.apiBase, DEFAULT_FLW_V4_API_BASE);
    assert.equal(c.flutterwave.tokenUrl, DEFAULT_FLW_V4_TOKEN_URL);
    assert.equal(c.flutterwave.configured, true);
    assert.equal(c.paymentsEnabled, false, 'v4 has no hosted checkout: FLW_V4_PAYMENT_METHOD is needed to turn the buttons on');
    assert.equal(loadConfig({ FLW_CLIENT_ID: CLIENT_ID, FLW_CLIENT_SECRET: CLIENT_SECRET, FLW_V4_PAYMENT_METHOD: 'OPay' }).paymentsEnabled, true);
    assert.equal(loadConfig({ FLW_CLIENT_ID: CLIENT_ID, FLW_CLIENT_SECRET: CLIENT_SECRET, FLW_V4_PAYMENT_METHOD: 'OPay' }).flutterwave.paymentMethod, 'opay');
  });

  it('accepts FLW_SECRET_KEY as the v4 client secret when FLW_CLIENT_SECRET is unset', () => {
    const c = loadConfig({ FLW_CLIENT_ID: CLIENT_ID, FLW_SECRET_KEY: 'pasted-client-secret' });
    assert.equal(c.flutterwave.version, 'v4');
    assert.equal(c.flutterwave.clientSecret, 'pasted-client-secret');
    assert.equal(c.flutterwave.secretKey, undefined);
    assert.equal(c.flutterwave.configured, true);
    const both = loadConfig({ FLW_CLIENT_ID: CLIENT_ID, FLW_SECRET_KEY: 'old', FLW_CLIENT_SECRET: 'new' });
    assert.equal(both.flutterwave.clientSecret, 'new');
  });

  it('honours an explicit FLW_API_VERSION and FLW_API_BASE', () => {
    const v3 = loadConfig({ FLW_API_VERSION: 'v3', FLW_CLIENT_ID: CLIENT_ID, FLW_SECRET_KEY: 'FLWSECK-x', FLW_API_BASE: 'https://flw.test/v3/' });
    assert.equal(v3.flutterwave.version, 'v3');
    assert.equal(v3.flutterwave.secretKey, 'FLWSECK-x');
    assert.equal(v3.flutterwave.clientId, undefined);
    assert.equal(v3.flutterwave.apiBase, 'https://flw.test/v3');
    const v4 = loadConfig({ FLW_API_VERSION: 'V4', FLW_CLIENT_ID: CLIENT_ID, FLW_SECRET_KEY: 'secret', FLW_API_BASE: 'https://developersandbox-api.flutterwave.com/' });
    assert.equal(v4.flutterwave.version, 'v4');
    assert.equal(v4.flutterwave.apiBase, 'https://developersandbox-api.flutterwave.com');
    const incomplete = loadConfig({ FLW_API_VERSION: 'v4', FLW_SECRET_KEY: 'secret' });
    assert.equal(incomplete.flutterwave.configured, false, 'v4 without a client id cannot authenticate');
    assert.equal(incomplete.paymentsEnabled, false);
    assert.throws(() => loadConfig({ FLW_API_VERSION: 'v5' }), /FLW_API_VERSION/);
  });
});

describe('v4 access token', () => {
  it('is fetched once with client credentials and reused across requests', async () => {
    const h = harness();
    await startOrder(h);
    await startOrder(h);
    const tokens = h.tokenCalls();
    assert.equal(tokens.length, 1);
    const tok = tokens[0]!;
    assert.equal(tok.method, 'POST');
    assert.match(tok.headers['content-type'] ?? '', /application\/x-www-form-urlencoded/);
    assert.equal(tok.form?.get('grant_type'), 'client_credentials');
    assert.equal(tok.form?.get('client_id'), CLIENT_ID);
    assert.equal(tok.form?.get('client_secret'), CLIENT_SECRET);
    assert.equal(tok.headers.authorization, undefined);
    const api = h.apiCalls();
    assert.equal(api.length, 2);
    for (const c of api) {
      assert.equal(c.headers.authorization, 'Bearer tok-1');
      assert.match(c.headers['x-idempotency-key'] ?? '', /^[A-Za-z0-9]{12,255}$/);
      assert.match(c.headers['x-trace-id'] ?? '', /^[A-Za-z0-9]{12,255}$/);
    }
    assert.notEqual(api[0]!.headers['x-idempotency-key'], api[1]!.headers['x-idempotency-key']);
  });

  it('is refreshed a minute before expires_in runs out', async () => {
    const h = harness();
    await startOrder(h);
    h.clock.now += 8 * 60_000;
    await startOrder(h);
    assert.equal(h.tokenCalls().length, 1, 'still valid at 8 of 10 minutes');
    h.clock.now += 61_000; // 9 min 1 s: inside the one-minute refresh margin
    await startOrder(h);
    assert.equal(h.tokenCalls().length, 2);
    assert.equal(h.apiCalls().at(-1)?.headers.authorization, 'Bearer tok-2');
  });

  it('retries once with a fresh token after a 401, keeping the idempotency key', async () => {
    const h = harness({ responder: v4Responder(succeeded(), { rejectTokens: [1] }) });
    const { order, location } = await startOrder(h);
    assert.match(location, new RegExp(`^${HOSTED}`));
    assert.equal(order.status, 'pending');
    assert.deepEqual(
      h.calls.map((c) => (c.url === TOKEN_URL ? 'token' : `${c.method} ${c.url.slice(API.length)} ${c.headers.authorization}`)),
      ['token', 'POST /orchestration/direct-charges Bearer tok-1', 'token', 'POST /orchestration/direct-charges Bearer tok-2'],
    );
    const posts = h.apiCalls();
    assert.equal(posts[0]!.headers['x-idempotency-key'], posts[1]!.headers['x-idempotency-key']);
  });

  it('gives up after one retry and marks the order failed', async () => {
    const h = harness({ responder: v4Responder(succeeded(), { rejectTokens: [1, 2, 3] }) });
    const res = await h.app.request('/pay/play', form({ email: 'ada@example.com' }));
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Unauthorized/);
    assert.equal(h.tokenCalls().length, 2);
    assert.equal(h.apiCalls().length, 2);
    assert.equal(h.store.listOrders()[0]?.status, 'failed');
  });

  it('surfaces an IdP refusal without calling the API', async () => {
    const h = harness({ responder: v4Responder(succeeded(), { tokenError: true }) });
    const res = await h.app.request('/pay/play', form({ email: 'ada@example.com' }));
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Could not get a Flutterwave access token: Invalid client/);
    assert.equal(h.apiCalls().length, 0);
    assert.equal(h.store.listOrders()[0]?.status, 'failed');
  });
});

describe('v4 checkout (POST /pay/:plan)', () => {
  it('creates an orchestrator charge, stores the charge id and redirects to next_action.redirect_url', async () => {
    const h = harness();
    const res = await h.app.request('/pay/both', form({ email: 'ada@example.com' }, { 'x-forwarded-for': '203.0.113.9' }));
    assert.equal(res.status, 303, await res.text());
    assert.match(res.headers.get('location') ?? '', new RegExp(`^${HOSTED}\\?opay&token=chg_`));

    const [order] = h.store.listOrders();
    assert.ok(order);
    assert.equal(order.status, 'pending');
    assert.equal(order.plan, 'both');
    assert.equal(order.amount_cents, 29900);
    assert.equal(order.currency, 'USD');
    assert.equal(order.flw_id, 'chg_000001');
    assert.equal(order.ip, '203.0.113.9');

    const call = h.apiCalls()[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `${API}/orchestration/direct-charges`);
    assert.match(call.headers['content-type'] ?? '', /application\/json/);
    assert.equal(call.json?.amount, 299);
    assert.equal(call.json?.currency, 'USD');
    assert.equal(call.json?.reference, order.id);
    assert.equal(call.json?.redirect_url, `https://storelint.example/pay/return?tx_ref=${order.id}`);
    assert.deepEqual(call.json?.customer, { email: 'ada@example.com' });
    assert.deepEqual(call.json?.payment_method, { type: 'opay' });
    assert.deepEqual(call.json?.meta, { order_id: order.id, plan: 'both', title: 'StoreLint release ops', description: 'Both stores ($299)' });
    assert.equal(call.json?.tx_ref, undefined);
  });

  it('fails cleanly when the charge comes back with a non-redirect next_action', async () => {
    const h = harness({ responder: v4Responder(succeeded(), { nextAction: { type: 'payment_instruction', payment_instruction: { note: 'Dial *123#' } } }) });
    const res = await h.app.request('/pay/play', form({ email: 'ada@example.com' }));
    assert.equal(res.status, 502);
    const html = await res.text();
    assert.match(html, /did not return a redirect for payment method &quot;opay&quot; \(next_action: payment_instruction\)/);
    assert.equal(h.store.listOrders()[0]?.status, 'failed');
  });

  it('keeps the checkout buttons off under v4 until FLW_V4_PAYMENT_METHOD is set', async () => {
    const h = harness({ env: { FLW_V4_PAYMENT_METHOD: '' } });
    assert.equal(h.config.paymentsEnabled, false);
    const html = await (await h.app.request('/ship')).text();
    assert.match(html, /href="\/ship\?plan=play#lead"/);
    assert.doesNotMatch(html, /action="\/pay\/play"/);
    assert.equal((await h.app.request('/pay/play', form({ email: 'a@b.co' }))).status, 404);
    assert.equal(h.calls.length, 0);
    // Verification and webhooks still work for charges created elsewhere.
    const body = v4Event({ id: 'sl_ffffffffffffffff' }, 'chg_1');
    const res = await h.app.request('/webhooks/flutterwave', webhook(body, { 'flutterwave-signature': sign(body) }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: 'unknown order' });
  });
});

describe('v4 return (GET /pay/return)', () => {
  it('verifies the stored charge by id even when the query has no transaction_id', async () => {
    const h = harness();
    const { order, chargeId } = await startOrder(h);
    const res = await h.app.request(`/pay/return?tx_ref=${order.id}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Payment received/);
    const paid = h.store.getOrder(order.id)!;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.flw_id, chargeId);
    assert.match(paid.raw_json ?? '', /"status":"successful"/);
    assert.match(paid.raw_json ?? '', /"api_version":"v4"/);
    const verifies = h.apiCalls().filter((c) => c.method === 'GET');
    assert.equal(verifies.length, 1);
    assert.equal(verifies[0]!.url, `${API}/charges/${chargeId}`);
    assert.equal(verifies[0]!.headers.authorization, 'Bearer tok-1');
    assert.equal(verifies[0]!.headers['x-idempotency-key'], undefined, 'GET carries no idempotency key');
    assert.match(verifies[0]!.headers['x-trace-id'] ?? '', /^[A-Za-z0-9]{12,255}$/);
  });

  it('prefers an explicit transaction_id and never pays on a mismatch', async () => {
    const h = harness({ responder: v4Responder(succeeded({ amount: 5 })) });
    const { order, chargeId } = await startOrder(h);
    const res = await h.app.request(`/pay/return?tx_ref=${order.id}&transaction_id=${chargeId}&status=successful`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /amount 5 is below 149\.00/);
    assert.equal(h.store.getOrder(order.id)?.status, 'failed');
  });

  it('maps v4 statuses: pending stays pending, voided becomes cancelled, wrong reference fails', async () => {
    const pending = harness({ responder: v4Responder(succeeded({ status: 'pending' })) });
    const p = await startOrder(pending);
    await pending.app.request(`/pay/return?tx_ref=${p.order.id}`);
    assert.equal(pending.store.getOrder(p.order.id)?.status, 'pending');

    const voided = harness({ responder: v4Responder(succeeded({ status: 'voided' })) });
    const v = await startOrder(voided);
    await voided.app.request(`/pay/return?tx_ref=${v.order.id}`);
    assert.equal(voided.store.getOrder(v.order.id)?.status, 'cancelled');

    const other = harness({ responder: v4Responder(succeeded({ reference: 'sl_0000000000000000' })) });
    const o = await startOrder(other);
    await other.app.request(`/pay/return?tx_ref=${o.order.id}`);
    assert.equal(other.store.getOrder(o.order.id)?.status, 'failed');
  });
});

describe('v4 webhook (POST /webhooks/flutterwave)', () => {
  it('accepts a body signed with base64 HMAC-SHA256 of the raw body and re-verifies by charge id', async () => {
    const h = harness();
    const { order, chargeId } = await startOrder(h);
    const body = v4Event(order, chargeId);
    const res = await h.app.request('/webhooks/flutterwave', webhook(body, { 'flutterwave-signature': sign(body) }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, order: order.id, status: 'paid' });
    assert.equal(h.store.getOrder(order.id)?.status, 'paid');
    assert.equal(h.apiCalls().filter((c) => c.method === 'GET').length, 1);
  });

  it('rejects a missing, wrong, differently keyed or v3-style header with 401 and touches nothing', async () => {
    const h = harness();
    const { order, chargeId } = await startOrder(h);
    const body = v4Event(order, chargeId);
    const attempts: Record<string, string>[] = [
      {},
      { 'flutterwave-signature': sign(body, 'another-secret') },
      { 'flutterwave-signature': sign(`${body} `) },
      { 'flutterwave-signature': Buffer.from('nope').toString('base64') },
      { 'verif-hash': HASH },
    ];
    for (const headers of attempts) {
      const res = await h.app.request('/webhooks/flutterwave', webhook(body, headers));
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
    assert.equal(h.apiCalls().filter((c) => c.method === 'GET').length, 0);
    assert.equal(h.store.getOrder(order.id)?.status, 'pending');
  });

  it('rejects a valid signature over a different body', async () => {
    const h = harness();
    const { order, chargeId } = await startOrder(h);
    const signed = v4Event(order, chargeId);
    const tampered = v4Event(order, chargeId, { amount: 1 });
    const res = await h.app.request('/webhooks/flutterwave', webhook(tampered, { 'flutterwave-signature': sign(signed) }));
    assert.equal(res.status, 401);
  });

  it("also accepts the secret hash sent verbatim, as the docs' framework samples compare", async () => {
    const h = harness();
    const { order, chargeId } = await startOrder(h);
    const res = await h.app.request('/webhooks/flutterwave', webhook(v4Event(order, chargeId), { 'flutterwave-signature': HASH }));
    assert.equal(res.status, 200);
    assert.equal(h.store.getOrder(order.id)?.status, 'paid');
  });

  it('is locked when FLW_WEBHOOK_HASH is unset', async () => {
    const h = harness({ env: { FLW_WEBHOOK_HASH: '' } });
    const { order, chargeId } = await startOrder(h);
    const body = v4Event(order, chargeId);
    assert.equal((await h.app.request('/webhooks/flutterwave', webhook(body, { 'flutterwave-signature': sign(body, '') }))).status, 401);
    assert.equal((await h.app.request('/webhooks/flutterwave', webhook(body, { 'flutterwave-signature': '' }))).status, 401);
  });

  it('trusts the API, not the webhook body, and ignores other events and bad JSON', async () => {
    const h = harness({ responder: v4Responder(succeeded({ status: 'failed' })) });
    const { order, chargeId } = await startOrder(h);
    const body = v4Event(order, chargeId, { status: 'succeeded' });
    const res = await h.app.request('/webhooks/flutterwave', webhook(body, { 'flutterwave-signature': sign(body) }));
    assert.equal(res.status, 200);
    assert.equal(h.store.getOrder(order.id)?.status, 'failed');

    const other = JSON.stringify({ type: 'charge.failed', data: { id: chargeId, reference: order.id } });
    const ignored = await h.app.request('/webhooks/flutterwave', webhook(other, { 'flutterwave-signature': sign(other) }));
    assert.equal(ignored.status, 200);
    assert.deepEqual(await ignored.json(), { ok: true, ignored: 'charge.failed' });

    const bad = await h.app.request('/webhooks/flutterwave', webhook('{nope', { 'flutterwave-signature': sign('{nope') }));
    assert.equal(bad.status, 400);
  });
});

describe('normalizeV4Charge', () => {
  it('maps the v4 charge into the shape judgePayment expects', () => {
    const base = { id: 'chg_1', reference: 'sl_00', status: 'succeeded', amount: 149, currency: 'USD' };
    const n = normalizeV4Charge(base);
    assert.equal(n.status, 'successful');
    assert.equal(n.tx_ref, 'sl_00');
    assert.equal(n.id, 'chg_1');
    assert.equal(n.amount, 149);
    assert.equal(n.customer, undefined);
    assert.equal(n.api_version, 'v4');
    assert.equal(normalizeV4Charge({ ...base, status: 'voided' }).status, 'cancelled');
    assert.equal(normalizeV4Charge({ ...base, status: 'PENDING' }).status, 'pending');
    assert.equal(normalizeV4Charge({ ...base, customer: 'cus_123' }).customer, undefined);
    assert.deepEqual(normalizeV4Charge({ ...base, customer: { id: 'cus_123', email: 'a@b.co' } }).customer, { email: 'a@b.co' });
  });
});
