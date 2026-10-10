import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Admin password hashing: `scrypt:<N>:<r>:<p>:<saltB64url>:<hashB64url>` (node:crypto scrypt, 32-byte key).
 * The format has no `$`, so it survives env files and dashboards that interpolate dollar signs.
 */
export const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs about 128 * N * r bytes; give it headroom over Node's 32 MB default for larger N.
    scrypt(password, salt, keylen, { N, r, p, maxmem: Math.max(32 * 1024 * 1024, 256 * N * r) }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function parsePasswordHash(stored: string): ParsedHash | undefined {
  const parts = stored.trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0) return undefined;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[4] ?? '') || !/^[A-Za-z0-9_-]+$/.test(parts[5] ?? '')) return undefined;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const hash = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length < 8 || hash.length < 16 || hash.length > 128) return undefined;
  return { N, r, p, salt, hash };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_DEFAULTS;
  const hash = await derive(password, salt, N, r, p, keylen);
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

/** Constant-time check of `password` against a stored hash. Malformed hashes never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  try {
    const key = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.hash.length);
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}
