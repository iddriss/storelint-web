export interface PayLinks {
  play?: string;
  ios?: string;
  both?: string;
  fix?: string;
}

export interface FlutterwaveConfig {
  /** Dashboard -> Settings -> API keys -> Secret key. Unset disables hosted checkout. */
  secretKey: string | undefined;
  /** Dashboard -> Settings -> Webhooks -> Secret hash. Sent back as the `verif-hash` header. */
  webhookHash: string | undefined;
  /** ISO currency the hosted page charges in (default USD). */
  currency: string;
  /** API base, default https://api.flutterwave.com/v3 (overridable for local checks). */
  apiBase: string;
}

export interface Config {
  port: number;
  dataDir: string;
  adminToken: string | undefined;
  payLinks: PayLinks;
  /** Public origin used for redirect_url (no trailing slash). */
  publicUrl: string;
  flutterwave: FlutterwaveConfig;
  /** True when FLW_SECRET_KEY is set: price cards post to /pay/:plan unless a PAY_LINK_* wins. */
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.PORT ?? '', 10);
  const secretKey = nonEmpty(env.FLW_SECRET_KEY);
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
      secretKey,
      webhookHash: nonEmpty(env.FLW_WEBHOOK_HASH),
      currency: (nonEmpty(env.FLW_CURRENCY) ?? 'USD').toUpperCase(),
      apiBase: (nonEmpty(env.FLW_API_BASE) ?? DEFAULT_FLW_API_BASE).replace(/\/+$/, ''),
    },
    paymentsEnabled: Boolean(secretKey),
    maxUploadBytes: 50 * 1024 * 1024,
    reportTtlMs: 7 * 24 * 60 * 60 * 1000,
    rateLimit: { limit: 10, windowMs: 60 * 60 * 1000 },
    scanTimeoutMs: 60_000,
  };
}
