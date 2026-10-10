import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { validateLead } from './leads.js';
import type { RateLimiter } from './ratelimit.js';
import { createRateLimiter } from './ratelimit.js';
import { ScanInputError, scanUploadedZip } from './scan-service.js';
import type { Scanner } from './scanner.js';
import { errorMessage, normalizeReport } from './scanner.js';
import type { Report } from './types.js';
import { renderError } from './views/html.js';
import { renderLanding } from './views/landing.js';
import { renderReport } from './views/report.js';
import { renderShip, renderThanks } from './views/ship.js';

export interface AppDeps {
  store: Store;
  config: Config;
  scanner: Scanner;
  limiter?: RateLimiter;
  now?: () => number;
}

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
  const app = new Hono();

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

  const rateLimited =
    (json: boolean): MiddlewareHandler =>
    async (c, next) => {
      const result = limiter.hit(clientIp(c));
      if (!result.allowed) {
        c.header('Retry-After', String(result.retryAfterSec));
        const msg = `Rate limit reached: ${config.rateLimit.limit} scans per hour per IP. Try again in ${Math.ceil(result.retryAfterSec / 60)} min, or run the CLI locally.`;
        return json ? c.json({ error: msg }, 429) : c.html(renderError(429, 'Too many scans', msg), 429);
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

  app.get('/', (c) => c.html(renderLanding({ payLinks: config.payLinks, scannerAvailable: scanner.available })));

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

  app.get('/ship', (c) => c.html(renderShip({ payLinks: config.payLinks, plan: c.req.query('plan') })));

  app.post('/ship', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return c.html(renderError(400, 'Bad request', 'Could not read the form.'), 400);
    }
    const result = validateLead(body);
    if (!result.ok) {
      return c.html(renderShip({ payLinks: config.payLinks, values: result.values, errors: result.errors }), 400);
    }
    if (!result.spam) store.insertLead({ ...result.lead, ip: clientIp(c) });
    return c.html(renderThanks({ name: result.lead.name, platform: result.lead.platform }));
  });

  app.get('/admin/leads', (c) => {
    c.header('Cache-Control', 'no-store');
    const token = c.req.query('token') ?? '';
    if (!config.adminToken || !safeEqual(token, config.adminToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const leads = store.listLeads().map((l) => ({ ...l, created_at: new Date(l.created_at).toISOString() }));
    return c.json({ count: leads.length, leads });
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
