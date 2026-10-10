export interface PayLinks {
  play?: string;
  ios?: string;
  both?: string;
  fix?: string;
}

export interface Config {
  port: number;
  dataDir: string;
  adminToken: string | undefined;
  payLinks: PayLinks;
  /** Max accepted upload size in bytes (50 MB). */
  maxUploadBytes: number;
  /** How long a report stays available. */
  reportTtlMs: number;
  /** Rate limit for /scan and /api/scan, per IP per window. */
  rateLimit: { limit: number; windowMs: number };
  /** Wall-clock cap on a single scan() call. */
  scanTimeoutMs: number;
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.PORT ?? '', 10);
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
    maxUploadBytes: 50 * 1024 * 1024,
    reportTtlMs: 7 * 24 * 60 * 60 * 1000,
    rateLimit: { limit: 10, windowMs: 60 * 60 * 1000 },
    scanTimeoutMs: 60_000,
  };
}
