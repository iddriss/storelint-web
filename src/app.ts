import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { OrderRow, OrderStatus } from './db.js';
import type { Store } from './db.js';
import type { FlutterwaveClient, VerifiedTransaction, WebhookEvent } from './flutterwave.js';
import { FlutterwaveError, createFlutterwaveClient, judgePayment } from './flutterwave.js';
import { validateLead } from './leads.js';
import type { RateLimiter } from './ratelimit.js';
import { createRateLimiter } from './ratelimit.js';
import { ScanInputError, scanUploadedZip } from './scan-service.js';
import type { Scanner } from './scanner.js';
import { errorMessage, normalizeReport } from './scanner.js';
import type { Report } from './types.js';
import { renderAdmin } from './views/admin.js';
import { renderError } from './views/html.js';
import { renderLanding } from './views/landing.js';
import { isPlaceholderEmail, placeholderEmail, renderPaid, renderPayError, renderRetry } from './views/pay.js';
import { renderReport } from './views/report.js';
import { findTier, renderShip, renderThanks } from './views/ship.js';
import type { Tier } from './views/ship.js';

export interface AppDeps {
  store: Store;
  config: Config;
  scanner: Scanner;
  limiter?: RateLimiter;
  now?: () => number;
  /** Injected in tests to mock the Flutterwave API. */
  fetch?: typeof fetch;
  flutterwave?: FlutterwaveClient;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const STATIC_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function createApp(deps: AppDeps): Hono {
  const { store, config, scanner } = deps;
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? createRateLimiter({ ...config.rateLimit, now });
  const flw: FlutterwaveClient | undefined =
    deps.flutterwave ?? (config.flutterwave.configured ? createFlutterwaveClient({ ...config.flutterwave, fetch: deps.fetch, now }) : undefined);
  const checkoutOn = Boolean(flw) && config.paymentsEnabled;
  const app = new Hono();
  const cardOpts = { payLinks: config.payLinks, paymentsEnabled: checkoutOn };

  // ---- helpers -------------------------------------------------------------

  /** First X-Forwarded-For entry (Cloudflare -> Traefik -> us), else the socket address. */
  function clientIp(c: Context): string {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    try {
      const addr = getConnInfo(c).remote.address;
      if (addr) return addr;
    } catch {
      /* no socket (e.g. app.request() in tests) */
    }
    return 'unknown';
  }

  function publicOrigin(c: Context): string {
    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
    const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host;
    return `${proto}://${host}`;
  }

  /** Separate buckets per feature (`scan`, `pay`) so scanning never locks someone out of paying. */
  const rateLimited =
    (json: boolean, bucket = 'scan'): MiddlewareHandler =>
    async (c, next) => {
      const result = limiter.hit(`${bucket}:${clientIp(c)}`);
      if (!result.allowed) {
        c.header('Retry-After', String(result.retryAfterSec));
        const what = bucket === 'pay' ? 'checkout attempts' : 'scans';
        const msg = `Rate limit reached: ${config.rateLimit.limit} ${what} per hour per IP. Try again in ${Math.ceil(result.retryAfterSec / 60)} min${bucket === 'pay' ? '.' : ', or run the CLI locally.'}`;
        return json ? c.json({ error: msg }, 429) : c.html(renderError(429, bucket === 'pay' ? 'Too many attempts' : 'Too many scans', msg), 429);
      }
      await next();
    };

  const uploadLimit = (json: boolean): MiddlewareHandler =>
    bodyLimit({
      maxSize: config.maxUploadBytes + 64 * 1024, // multipart framing overhead
      onError: (c) => {
        const msg = `The upload is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB. Zip the project without node_modules, build output and .git.`;
        return json ? c.json({ error: msg }, 413) : c.html(renderError(413, 'Upload too large', msg), 413);
      },
    });

  async function runScan(c: Context): Promise<{ id: string; report: Report; url: string }> {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch (err) {
      throw new ScanInputError(`Could not read the upload: ${errorMessage(err)}`);
    }
    const file = body.file;
    if (!(file instanceof File)) throw new ScanInputError('Attach a .zip file in the "file" field.');
    if (file.size === 0) throw new ScanInputError('The uploaded file is empty.');
    if (file.size > config.maxUploadBytes) {
      throw new ScanInputError(`The upload is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const { row, report } = await scanUploadedZip(buffer, { store, scanner, scanTimeoutMs: config.scanTimeoutMs });
    return { id: row.id, report, url: `${publicOrigin(c)}/r/${row.id}` };
  }

  // ---- routes --------------------------------------------------------------

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/static/:name', async (c) => {
    const name = c.req.param('name');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return c.notFound();
    const type = STATIC_TYPES[path.extname(name)];
    if (!type) return c.notFound();
    try {
      const data = await readFile(path.join(PUBLIC_DIR, name));
      c.header('Content-Type', type);
      c.header('Cache-Control', 'public, max-age=3600');
      return c.body(data);
    } catch {
      return c.notFound();
    }
  });

  app.get('/', (c) => c.html(renderLanding({ ...cardOpts, scannerAvailable: scanner.available })));

  app.post('/scan', rateLimited(false), uploadLimit(false), async (c) => {
    try {
      const { id } = await runScan(c);
      return c.redirect(`/r/${id}`, 303);
    } catch (err) {
      if (err instanceof ScanInputError) return c.html(renderError(400, 'Could not scan that upload', err.message), 400);
      console.error('[scan] failed:', err);
      return c.html(renderError(500, 'Scan failed', 'Something went wrong while scanning. Please try again, or run the CLI locally.'), 500);
    }
  });

  app.post('/api/scan', rateLimited(true), uploadLimit(true), async (c) => {
    try {
      const { id, report, url } = await runScan(c);
      return c.json({ id, url, report }, 201);
    } catch (err) {
      if (err instanceof ScanInputError) return c.json({ error: err.message }, 400);
      console.error('[api/scan] failed:', err);
      return c.json({ error: 'Scan failed. Please try again.' }, 500);
    }
  });

  app.get('/r/:id', (c) => {
    const id = c.req.param('id');
    const row = /^[A-Za-z0-9_-]{8,32}$/.test(id) ? store.getReport(id, config.reportTtlMs) : undefined;
    if (!row) {
      return c.html(renderError(404, 'Report not found', 'This report does not exist or has expired. Reports are kept for 7 days.'), 404);
    }
    const report = normalizeReport(JSON.parse(row.report_json), 'project');
    c.header('Cache-Control', 'private, no-store');
    return c.html(
      renderReport({
        id,
        report,
        shareUrl: `${publicOrigin(c)}/r/${id}`,
        createdAt: row.created_at,
        expiresAt: row.created_at + config.reportTtlMs,
      }),
    );
  });

  app.get('/ship', (c) => c.html(renderShip({ ...cardOpts, plan: c.req.query('plan') })));

  app.post('/ship', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return c.html(renderError(400, 'Bad request', 'Could not read the form.'), 400);
    }
    const result = validateLead(body);
    if (!result.ok) {
      return c.html(renderShip({ ...cardOpts, values: result.values, errors: result.errors }), 400);
    }
    if (!result.spam) store.insertLead({ ...result.lead, ip: clientIp(c) });
    return c.html(renderThanks({ name: result.lead.name, platform: result.lead.platform }));
  });

  // ---- hosted checkout (Flutterwave) ---------------------------------------

  /**
   * Verifies a transaction with the provider and records the outcome on the order.
   * Idempotent: a paid order is never downgraded (see Store.updateOrder).
   */
  async function settleOrder(
    order: OrderRow,
    transactionId: string,
    source: 'return' | 'webhook',
  ): Promise<{ order: OrderRow; status: OrderStatus; reason?: string }> {
    if (order.status === 'paid') return { order, status: 'paid' };
    if (!flw) return { order, status: order.status, reason: 'payments are not configured' };
    let verified: VerifiedTransaction;
    try {
      verified = await flw.verifyTransaction(transactionId);
    } catch (err) {
      console.error(`[pay:${source}] verify failed for order ${order.id} / flw ${transactionId}:`, err);
      // Leave the order pending: the webhook (or a later visit) can still settle it.
      return { order, status: order.status, reason: 'the payment could not be verified yet' };
    }
    const verdict = judgePayment(order, verified);
    const providerStatus = String(verified.status).toLowerCase();
    const status: OrderStatus = verdict.paid ? 'paid' : providerStatus === 'cancelled' ? 'cancelled' : providerStatus === 'pending' ? 'pending' : 'failed';
    const customerEmail = verified.customer?.email;
    const { row, changed } = store.updateOrder(order.id, {
      status,
      flw_id: String(verified.id),
      raw_json: JSON.stringify(verified),
      email: typeof customerEmail === 'string' && EMAIL_RE.test(customerEmail) && !isPlaceholderEmail(customerEmail) ? customerEmail : undefined,
    });
    if (changed) console.log(`[pay:${source}] order ${order.id} -> ${status}${verdict.paid ? '' : ` (${verdict.reason})`}`);
    return { order: row ?? order, status: row?.status ?? status, reason: verdict.paid ? undefined : verdict.reason };
  }

  app.post('/pay/:plan', rateLimited(false, 'pay'), async (c) => {
    const tier: Tier | undefined = findTier(c.req.param('plan'));
    if (!tier) return c.html(renderError(404, 'Unknown package', 'Pick one of the packages on the pricing page.'), 404);
    if (!flw || !checkoutOn) return c.html(renderError(404, 'Checkout not available', 'Online payment is not enabled on this server. Use the request form instead.'), 404);
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      /* empty body is fine */
    }
    if (typeof body.website === 'string' && body.website.trim()) return c.redirect('/ship', 303); // honeypot
    const rawEmail = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
    const email = EMAIL_RE.test(rawEmail) ? rawEmail : '';

    const order = store.insertOrder({ plan: tier.key, amount_cents: tier.amountCents, currency: config.flutterwave.currency, email, ip: clientIp(c) });
    try {
      const { link, providerId } = await flw.createPayment({
        tx_ref: order.tx_ref,
        amount: order.amount_cents / 100,
        currency: order.currency,
        redirect_url: `${config.publicUrl}/pay/return`,
        customer: { email: email || placeholderEmail(order.id, config.publicUrl) },
        customizations: { title: 'StoreLint release ops', description: `${tier.name} (${tier.price})` },
        meta: { order_id: order.id, plan: tier.key },
      });
      if (providerId) store.updateOrder(order.id, { status: 'pending', flw_id: providerId });
      console.log(`[pay] order ${order.id} (${tier.key}, ${order.currency} ${order.amount_cents / 100}) -> hosted checkout (${flw.version}${providerId ? ` ${providerId}` : ''})`);
      c.header('Cache-Control', 'no-store');
      return c.redirect(link, 303);
    } catch (err) {
      const detail = err instanceof FlutterwaveError ? err.message : 'unexpected error';
      console.error(`[pay] create payment failed for order ${order.id}:`, err);
      store.updateOrder(order.id, { status: 'failed', raw_json: JSON.stringify({ stage: 'create', error: detail }) });
      return c.html(renderPayError({ tier, detail }), 502);
    }
  });

  app.get('/pay/return', rateLimited(false, 'pay'), async (c) => {
    c.header('Cache-Control', 'no-store');
    const txRef = c.req.query('tx_ref') ?? '';
    const qStatus = (c.req.query('status') ?? '').toLowerCase();
    const order = /^sl_[0-9a-f]{16}$/.test(txRef) ? store.getOrderByTxRef(txRef) : undefined;
    if (!order) return c.html(renderError(404, 'Order not found', 'We could not match this payment to an order. If you were charged, reply to the Flutterwave receipt.'), 404);
    const tier = findTier(order.plan);

    if (order.status === 'paid') return c.html(renderPaid({ order, tier }));

    // v3 appends transaction_id; v4 does not document what it appends, so fall back to the charge id we stored at creation.
    const transactionId = c.req.query('transaction_id') || order.flw_id || '';

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(transactionId)) {
      // Cancelled or failed before a transaction existed: nothing to verify.
      const status: OrderStatus = qStatus === 'cancelled' ? 'cancelled' : 'failed';
      const { row } = store.updateOrder(order.id, { status, raw_json: JSON.stringify({ stage: 'return', query: { status: qStatus } }) });
      return c.html(renderRetry({ order: row ?? order, tier, status }));
    }

    const result = await settleOrder(order, transactionId, 'return');
    if (result.status === 'paid') return c.html(renderPaid({ order: result.order, tier }));
    const shown = result.status === 'pending' ? 'pending' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    return c.html(renderRetry({ order: result.order, tier, status: shown, reason: result.reason }));
  });

  // Registered after /pay/return so the redirect never shadows it.
  app.get('/pay/:plan', (c) => c.redirect(`/ship?plan=${encodeURIComponent(c.req.param('plan'))}#prices`, 303));

  app.post('/webhooks/flutterwave', async (c) => {
    const rawBody = await c.req.text();
    if (!flw || !flw.verifyWebhook((name) => c.req.header(name), rawBody)) return c.json({ error: 'unauthorized' }, 401);
    let evt: WebhookEvent;
    try {
      evt = flw.parseWebhook(rawBody);
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (evt.event !== 'charge.completed') return c.json({ ok: true, ignored: evt.event });
    const order = evt.reference ? store.getOrderByTxRef(evt.reference) : undefined;
    const transactionId = evt.transactionId;
    if (!order || !transactionId) {
      console.warn(`[pay:webhook] charge.completed for unknown order tx_ref=${evt.reference} id=${transactionId}`);
      return c.json({ ok: true, ignored: 'unknown order' });
    }
    const result = await settleOrder(order, transactionId, 'webhook');
    return c.json({ ok: true, order: order.id, status: result.status });
  });

  // ---- admin ---------------------------------------------------------------

  function adminAuthorized(c: Context): boolean {
    c.header('Cache-Control', 'no-store');
    const token = c.req.query('token') ?? '';
    return Boolean(config.adminToken) && safeEqual(token, config.adminToken ?? '');
  }

  const iso = <T extends { created_at: number }>(rows: T[]) => rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));

  app.get('/admin/leads', (c) => {
    if (!adminAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    const leads = iso(store.listLeads());
    return c.json({ count: leads.length, leads });
  });

  app.get('/admin/orders', (c) => {
    if (!adminAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    const orders = iso(store.listOrders()).map((o) => ({ ...o, updated_at: new Date(o.updated_at).toISOString() }));
    return c.json({ count: orders.length, orders });
  });

  app.get('/admin', (c) => {
    if (!adminAuthorized(c)) return c.html(renderError(401, 'Unauthorized', 'Add ?token=ADMIN_TOKEN to the address.'), 401);
    return c.html(renderAdmin({ orders: store.listOrders(), leads: store.listLeads(), paymentsEnabled: checkoutOn }));
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
    return c.html(renderError(404, 'Page not found', 'There is nothing at this address.'), 404);
  });

  app.onError((err, c) => {
    console.error('[app] unhandled error:', err);
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'internal error' }, 500);
    return c.html(renderError(500, 'Something went wrong', 'Please try again in a moment.'), 500);
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
