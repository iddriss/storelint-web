import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from './config.js';
import type { Store } from './db.js';
import type { Outbox } from './mailer.js';
import type { Notifier } from './notify.js';
import type { RateLimiter } from './ratelimit.js';

/** What the route modules share. Built once in createApp. */
export interface RouteContext {
  app: Hono;
  store: Store;
  config: Config;
  now: () => number;
  outbox: Outbox;
  notifier: Notifier;
  /** True when price cards post to /pay/:plan. */
  checkoutOn: boolean;
  limiters: {
    /** Failed admin sign-ins per IP. */
    login: RateLimiter;
    /** Failed client-page lookups per IP. */
    orderLookup: RateLimiter;
    /** Intake saves per order. */
    intake: RateLimiter;
    /** Find-my-order requests per IP. */
    find: RateLimiter;
  };
}

/**
 * The visitor's address. Cloudflare sets CF-Connecting-IP itself and overwrites anything the client
 * sent, so it cannot be forged through the tunnel; X-Forwarded-For's first entry can be (the client
 * may send its own and Cloudflare appends). Prefer the former, fall back for non-Cloudflare setups.
 */
export function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
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

export function publicOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

/** Parses a urlencoded or multipart form; a malformed body reads as an empty form. */
export async function readForm(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function formText(body: Record<string, unknown>, name: string, max: number): string {
  const v = body[name];
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

/** Headers for pages that carry private data in the URL or the body (admin, client order pages). */
export function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
}

/** Cap for the small urlencoded forms of the admin and client pages (the largest field is 5 000 characters). */
export const smallFormLimit: MiddlewareHandler = bodyLimit({
  maxSize: 128 * 1024,
  onError: (c) => c.text('Request body too large.', 413),
});
