/**
 * Admin authentication primitives: password check, session ids, CSRF tokens, cookies.
 * Sessions live in the `sessions` table keyed by the SHA-256 of the id, so a copy of the
 * database does not hand out working cookies.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { parsePasswordHash, verifyPassword } from './password.js';

export const SESSION_COOKIE = 'sl_admin';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Do not rewrite the session row more often than this while sliding the expiry. */
export const SESSION_TOUCH_MS = 60 * 1000;
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Constant-time string comparison that does not leak the length of either side. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type AdminLoginMode = 'hash' | 'plain' | 'disabled';

/** `ADMIN_PASSWORD_HASH` (when well-formed) wins over `ADMIN_PASSWORD`; neither means login is off. */
export function adminLoginMode(config: Pick<Config, 'adminPasswordHash' | 'adminPassword'>): AdminLoginMode {
  if (config.adminPasswordHash && parsePasswordHash(config.adminPasswordHash)) return 'hash';
  if (config.adminPassword) return 'plain';
  return 'disabled';
}

export async function checkAdminPassword(config: Pick<Config, 'adminPasswordHash' | 'adminPassword'>, password: string): Promise<boolean> {
  const mode = adminLoginMode(config);
  if (mode === 'hash') return verifyPassword(password, config.adminPasswordHash ?? '');
  if (mode === 'plain') return safeEqual(password, config.adminPassword ?? '');
  return false;
}

/** 32 random bytes, base64url. Only its hash is stored. */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

/** Per-session CSRF token, derived from the session id so it needs no storage and cannot be computed from the database. */
export function csrfToken(sessionId: string): string {
  return createHmac('sha256', sessionId).update('storelint-admin-csrf').digest('base64url');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/admin; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** The token from `Authorization: Bearer <token>`, or undefined. Query strings are never consulted. */
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1];
}

// ---- checkout return cookie ----------------------------------------------------

export const PAY_COOKIE = 'sl_pay';

/** Proves this browser started the checkout for `orderId`, so /pay/return may reveal the private order link. */
export function payCookieValue(orderId: string, accessToken: string): string {
  return `${orderId}.${createHmac('sha256', accessToken).update('storelint-pay-return').digest('base64url')}`;
}

export function payCookie(orderId: string, accessToken: string): string {
  return `${PAY_COOKIE}=${payCookieValue(orderId, accessToken)}; Path=/pay; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`;
}
