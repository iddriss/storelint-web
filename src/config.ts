import type { FlwApiVersion } from './flutterwave.js';
import { DEFAULT_FLW_V4_TOKEN_URL } from './flutterwave.js';

export interface PayLinks {
  play?: string;
  ios?: string;
  both?: string;
  fix?: string;
}

export interface FlutterwaveConfig {
  /** `v3` (secret key) or `v4` (OAuth client credentials). See docs/FLUTTERWAVE.md. */
  version: FlwApiVersion;
  /** v3: Dashboard -> Settings -> API keys -> Secret key. */
  secretKey: string | undefined;
  /** v4: Dashboard -> Settings -> API keys (V4) -> Client ID. */
  clientId: string | undefined;
  /** v4: Client Secret (`FLW_CLIENT_SECRET`, falling back to `FLW_SECRET_KEY`). */
  clientSecret: string | undefined;
  /** v4: OAuth token endpoint (`FLW_TOKEN_URL`, overridable for local checks). */
  tokenUrl: string;
  /** v4: `payment_method.type` for the orchestrator (`FLW_V4_PAYMENT_METHOD`). Unset keeps checkout off under v4. */
  paymentMethod: string | undefined;
  /** Dashboard -> Settings -> Webhooks -> Secret hash (`verif-hash` in v3, HMAC key for `flutterwave-signature` in v4). */
  webhookHash: string | undefined;
  /** ISO currency the hosted page charges in (default USD). */
  currency: string;
  /** API base (`FLW_API_BASE`), default depends on the version. */
  apiBase: string;
  /** True when the credentials for the active version are present (client is created, webhooks verify). */
  configured: boolean;
}

export interface Config {
  port: number;
  dataDir: string;
  adminToken: string | undefined;
  payLinks: PayLinks;
  /** Public origin used for redirect_url (no trailing slash). */
  publicUrl: string;
  flutterwave: FlutterwaveConfig;
  /** True when hosted checkout can start: price cards post to /pay/:plan unless a PAY_LINK_* wins. */
  paymentsEnabled: boolean;
  /** Max accepted upload size in bytes (50 MB). */
  maxUploadBytes: number;
  /** How long a report stays available. */
  reportTtlMs: number;
  /** Rate limit for /scan, /api/scan and /pay/*, per IP per window. */
  rateLimit: { limit: number; windowMs: number };
  /** Wall-clock cap on a single scan() call. */
  scanTimeoutMs: number;
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export const DEFAULT_PUBLIC_URL = 'https://storelint.embracetech.org';
export const DEFAULT_FLW_API_BASE = 'https://api.flutterwave.com/v3';
/** v4 production base per https://developer.flutterwave.com/v4.0.0/docs/environments (sandbox: developersandbox-api.flutterwave.com). */
export const DEFAULT_FLW_V4_API_BASE = 'https://f4bexperience.flutterwave.com';
export const DEFAULT_FLW_V4_SANDBOX_API_BASE = 'https://developersandbox-api.flutterwave.com';

export function resolveFlwVersion(env: NodeJS.ProcessEnv): FlwApiVersion {
  const raw = nonEmpty(env.FLW_API_VERSION)?.toLowerCase();
  if (raw === undefined) return nonEmpty(env.FLW_CLIENT_ID) ? 'v4' : 'v3';
  if (raw === 'v3' || raw === '3') return 'v3';
  if (raw === 'v4' || raw === '4') return 'v4';
  throw new Error(`FLW_API_VERSION must be "v3" or "v4" (got "${raw}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.PORT ?? '', 10);
  const version = resolveFlwVersion(env);
  const secretKey = nonEmpty(env.FLW_SECRET_KEY);
  const clientId = nonEmpty(env.FLW_CLIENT_ID);
  const clientSecret = nonEmpty(env.FLW_CLIENT_SECRET) ?? secretKey;
  const paymentMethod = nonEmpty(env.FLW_V4_PAYMENT_METHOD)?.toLowerCase();
  const configured = version === 'v4' ? Boolean(clientId && clientSecret) : Boolean(secretKey);
  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    dataDir: nonEmpty(env.DATA_DIR) ?? '/data',
    adminToken: nonEmpty(env.ADMIN_TOKEN),
    payLinks: {
      play: nonEmpty(env.PAY_LINK_PLAY),
      ios: nonEmpty(env.PAY_LINK_IOS),
      both: nonEmpty(env.PAY_LINK_BOTH),
      fix: nonEmpty(env.PAY_LINK_FIX),
    },
    publicUrl: (nonEmpty(env.PUBLIC_URL) ?? DEFAULT_PUBLIC_URL).replace(/\/+$/, ''),
    flutterwave: {
      version,
      secretKey: version === 'v3' ? secretKey : undefined,
      clientId: version === 'v4' ? clientId : undefined,
      clientSecret: version === 'v4' ? clientSecret : undefined,
      tokenUrl: nonEmpty(env.FLW_TOKEN_URL) ?? DEFAULT_FLW_V4_TOKEN_URL,
      paymentMethod,
      webhookHash: nonEmpty(env.FLW_WEBHOOK_HASH),
      currency: (nonEmpty(env.FLW_CURRENCY) ?? 'USD').toUpperCase(),
      apiBase: (nonEmpty(env.FLW_API_BASE) ?? (version === 'v4' ? DEFAULT_FLW_V4_API_BASE : DEFAULT_FLW_API_BASE)).replace(/\/+$/, ''),
      configured,
    },
    paymentsEnabled: configured && (version === 'v3' || Boolean(paymentMethod)),
    maxUploadBytes: 50 * 1024 * 1024,
    reportTtlMs: 7 * 24 * 60 * 60 * 1000,
    rateLimit: { limit: 10, windowMs: 60 * 60 * 1000 },
    scanTimeoutMs: 60_000,
  };
}
