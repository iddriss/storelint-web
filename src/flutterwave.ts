/**
 * Minimal Flutterwave client (fetch only, no SDK) for both API generations.
 *
 * v3: secret-key bearer auth, POST /payments (hosted page), GET /transactions/:id/verify,
 *     `verif-hash` webhook header (plain secret compare).
 *     https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1
 *     https://developer.flutterwave.com/docs/transaction-verification
 *     https://developer.flutterwave.com/v3.0/docs/webhooks
 *
 * v4: OAuth 2.0 client-credentials token (idp.flutterwave.com), POST /orchestration/direct-charges
 *     (returns data.next_action.redirect_url.url), GET /charges/:id, `flutterwave-signature`
 *     webhook header (base64 HMAC-SHA256 of the raw body with the dashboard secret hash).
 *     https://developer.flutterwave.com/v4.0.0/docs/authentication
 *     https://developer.flutterwave.com/v4.0.0/docs/environments
 *     https://developer.flutterwave.com/v4.0.0/docs/api-headers
 *     https://developer.flutterwave.com/v4.0.0/docs/payment-orchestrator-flow
 *     https://developer.flutterwave.com/v4.0.0/reference/charges_get
 *     https://developer.flutterwave.com/v4.0.0/docs/webhooks
 *
 * Everything the routes consume is normalized here so src/app.ts does not care which version is active.
 * See docs/FLUTTERWAVE.md for the full write-up and sources.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type FlwApiVersion = 'v3' | 'v4';

export interface FlutterwaveClientOptions {
  version: FlwApiVersion;
  /** API base without trailing slash. */
  apiBase: string;
  /** v3: dashboard secret key. */
  secretKey?: string;
  /** v4: OAuth client id (`FLWPUBK-...-X`). */
  clientId?: string;
  /** v4: OAuth client secret. */
  clientSecret?: string;
  /** v4: token endpoint (default https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token). */
  tokenUrl?: string;
  /** v4: `payment_method.type` sent to the orchestrator (see docs/FLUTTERWAVE.md). */
  paymentMethod?: string;
  /** Dashboard "secret hash". Unset means every webhook is rejected. */
  webhookHash?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface CreatePaymentRequest {
  tx_ref: string;
  /** Major units (149 for $149.00). */
  amount: number;
  currency: string;
  redirect_url: string;
  customer: { email: string; name?: string };
  customizations: { title: string; description: string; logo?: string };
  meta?: Record<string, string | number>;
}

export interface CreatedPayment {
  /** Where to send the buyer. */
  link: string;
  /** Provider transaction id when it is known at creation (v4 charge id). */
  providerId?: string;
}

/**
 * Normalized verified transaction. `status` is `successful` for a settled payment in both versions
 * (v4 `succeeded` is mapped), `cancelled` for v3 `cancelled` / v4 `voided`, otherwise the provider's word.
 */
export interface VerifiedTransaction {
  id: number | string;
  tx_ref: string;
  status: string;
  amount: number;
  currency: string;
  charged_amount?: number;
  customer?: { email?: string; name?: string };
  [key: string]: unknown;
}

/** Normalized webhook event; `event` is `charge.completed` for a finished payment in both versions. */
export interface WebhookEvent {
  event: string;
  transactionId: string;
  reference: string;
}

export class FlutterwaveError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'FlutterwaveError';
  }
}

export interface FlutterwaveClient {
  readonly version: FlwApiVersion;
  /** Creates the provider-side payment and returns the page to redirect the buyer to. */
  createPayment(req: CreatePaymentRequest): Promise<CreatedPayment>;
  /** Fetches the transaction/charge by provider id. */
  verifyTransaction(id: string | number): Promise<VerifiedTransaction>;
  /** True when the webhook request carries a valid signature for this version. */
  verifyWebhook(header: (name: string) => string | undefined, rawBody: string): boolean;
  /** Parses a webhook body into the normalized shape. Throws on invalid JSON. */
  parseWebhook(rawBody: string): WebhookEvent;
}

export const DEFAULT_FLW_V4_TOKEN_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
/** Refresh the token this long before `expires_in` runs out (docs: "at least one minute before"). */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_S = 600;

interface Envelope {
  status?: string;
  message?: string;
  data?: unknown;
  error?: { type?: unknown; code?: unknown; message?: unknown };
}

interface HttpResult {
  res: Response;
  body: Envelope | undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 32 alphanumeric chars: valid for v4 `X-Idempotency-Key` / `X-Trace-Id` (alphanumeric, 12-255 chars). */
function requestId(): string {
  return randomUUID().replace(/-/g, '');
}

function envelopeMessage(res: Response, body: Envelope | undefined): string {
  if (body?.message) return String(body.message);
  if (body?.error?.message) return String(body.error.message);
  return `HTTP ${res.status}`;
}

async function send(doFetch: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<HttpResult> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new FlutterwaveError(`Could not reach Flutterwave: ${err instanceof Error ? err.message : String(err)}`);
  }
  let body: Envelope | undefined;
  try {
    body = (await res.json()) as Envelope;
  } catch {
    body = undefined;
  }
  return { res, body };
}

export function createFlutterwaveClient(o: FlutterwaveClientOptions): FlutterwaveClient {
  return o.version === 'v4' ? createFlutterwaveV4Client(o) : createFlutterwaveV3Client(o);
}

// ---- v3 ---------------------------------------------------------------------

export function createFlutterwaveV3Client(o: FlutterwaveClientOptions): FlutterwaveClient {
  if (!o.secretKey) throw new Error('Flutterwave v3 needs FLW_SECRET_KEY');
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const headers = {
    Authorization: `Bearer ${o.secretKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function call(path: string, init: RequestInit): Promise<Envelope> {
    const { res, body } = await send(doFetch, `${o.apiBase}${path}`, { ...init, headers }, timeoutMs);
    if (!res.ok || body?.status !== 'success') throw new FlutterwaveError(`Flutterwave error: ${envelopeMessage(res, body)}`, res.status, body);
    return body;
  }

  return {
    version: 'v3',
    async createPayment(req) {
      const body = await call('/payments', { method: 'POST', body: JSON.stringify(req) });
      const link = (body.data as { link?: unknown } | undefined)?.link;
      if (typeof link !== 'string' || !/^https:\/\//i.test(link)) {
        throw new FlutterwaveError('Flutterwave did not return a hosted payment link.', undefined, body);
      }
      return { link };
    },
    async verifyTransaction(id) {
      const safe = encodeURIComponent(String(id));
      const body = await call(`/transactions/${safe}/verify`, { method: 'GET' });
      const data = body.data as VerifiedTransaction | null | undefined;
      if (!data || typeof data !== 'object') throw new FlutterwaveError('Flutterwave returned no transaction data.', undefined, body);
      return data;
    },
    verifyWebhook(header) {
      const hash = header('verif-hash') ?? '';
      return Boolean(o.webhookHash) && Boolean(hash) && safeEqual(hash, o.webhookHash ?? '');
    },
    parseWebhook(rawBody) {
      const payload = JSON.parse(rawBody) as { event?: unknown; data?: { id?: unknown; tx_ref?: unknown } };
      const id = payload.data?.id;
      return {
        event: typeof payload.event === 'string' ? payload.event : '',
        transactionId: typeof id === 'number' || typeof id === 'string' ? String(id) : '',
        reference: typeof payload.data?.tx_ref === 'string' ? payload.data.tx_ref : '',
      };
    },
  };
}

// ---- v4 ---------------------------------------------------------------------

interface V4Charge {
  id?: unknown;
  status?: unknown;
  reference?: unknown;
  amount?: unknown;
  currency?: unknown;
  customer?: unknown;
  customer_id?: unknown;
  next_action?: { type?: unknown; redirect_url?: { url?: unknown } };
  [key: string]: unknown;
}

/** v4 charge status -> the vocabulary judgePayment and the routes already use. */
function normalizeV4Status(status: unknown): string {
  const s = String(status ?? '').toLowerCase();
  if (s === 'succeeded' || s === 'successful') return 'successful';
  if (s === 'voided' || s === 'cancelled') return 'cancelled';
  return s;
}

export function normalizeV4Charge(data: V4Charge): VerifiedTransaction {
  const customer = data.customer;
  const email = customer && typeof customer === 'object' ? (customer as { email?: unknown }).email : undefined;
  return {
    ...data,
    id: typeof data.id === 'number' || typeof data.id === 'string' ? data.id : '',
    tx_ref: typeof data.reference === 'string' ? data.reference : '',
    status: normalizeV4Status(data.status),
    amount: Number(data.amount),
    currency: String(data.currency ?? ''),
    customer: typeof email === 'string' ? { email } : undefined,
    api_version: 'v4',
  };
}

export function createFlutterwaveV4Client(o: FlutterwaveClientOptions): FlutterwaveClient {
  if (!o.clientId || !o.clientSecret) throw new Error('Flutterwave v4 needs FLW_CLIENT_ID and FLW_CLIENT_SECRET');
  const clientId = o.clientId;
  const clientSecret = o.clientSecret;
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const tokenUrl = o.tokenUrl ?? DEFAULT_FLW_V4_TOKEN_URL;
  const paymentMethod = o.paymentMethod;

  // -- cached client-credentials token (10 min TTL per the docs; refreshed a minute early) --
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
    const { res, body } = await send(
      doFetch,
      tokenUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() },
      timeoutMs,
    );
    const tok = body as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | undefined;
    if (!res.ok || typeof tok?.access_token !== 'string' || !tok.access_token) {
      const detail = typeof tok?.error_description === 'string' ? tok.error_description : typeof tok?.error === 'string' ? tok.error : `HTTP ${res.status}`;
      throw new FlutterwaveError(`Could not get a Flutterwave access token: ${detail}`, res.status, body);
    }
    const ttl = Number(tok.expires_in);
    const lifetimeMs = (Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_S) * 1000;
    cached = { token: tok.access_token, expiresAt: now() + lifetimeMs - Math.min(TOKEN_REFRESH_MARGIN_MS, lifetimeMs / 2) };
    return tok.access_token;
  }

  function getToken(): Promise<string> {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.token);
    if (!inflight) {
      inflight = fetchToken().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  }

  /** Authenticated call; on 401 the token is dropped and the request retried once with a fresh one. */
  async function call(path: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }): Promise<Envelope> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Trace-Id': requestId(),
      ...(init.method === 'POST' || init.method === 'PUT' ? { 'X-Idempotency-Key': requestId() } : {}),
      ...init.headers,
    };
    const attempt = async (token: string) => send(doFetch, `${o.apiBase}${path}`, { ...init, headers: { ...headers, Authorization: `Bearer ${token}` } }, timeoutMs);
    let result = await attempt(await getToken());
    if (result.res.status === 401) {
      cached = undefined;
      result = await attempt(await getToken());
    }
    const { res, body } = result;
    if (!res.ok || body?.status !== 'success') throw new FlutterwaveError(`Flutterwave error: ${envelopeMessage(res, body)}`, res.status, body);
    return body;
  }

  return {
    version: 'v4',
    async createPayment(req) {
      if (!paymentMethod) {
        throw new FlutterwaveError(
          'Flutterwave v4 has no hosted checkout yet: set FLW_V4_PAYMENT_METHOD to a redirect-capable payment_method.type (see docs/FLUTTERWAVE.md) or switch the account back to v3 keys.',
        );
      }
      // Flutterwave does not document which query parameters v4 appends to redirect_url, so we add our own reference.
      const redirect = new URL(req.redirect_url);
      redirect.searchParams.set('tx_ref', req.tx_ref);
      const payload = {
        amount: req.amount,
        currency: req.currency,
        reference: req.tx_ref,
        redirect_url: redirect.toString(),
        customer: { email: req.customer.email },
        payment_method: { type: paymentMethod },
        meta: { ...req.meta, title: req.customizations.title, description: req.customizations.description },
      };
      const body = await call('/orchestration/direct-charges', { method: 'POST', body: JSON.stringify(payload) });
      const data = (body.data ?? {}) as V4Charge;
      const next = data.next_action;
      const url = next?.redirect_url?.url;
      if (next?.type !== 'redirect_url' || typeof url !== 'string' || !/^https:\/\//i.test(url)) {
        const kind = typeof next?.type === 'string' ? next.type : 'none';
        throw new FlutterwaveError(
          `Flutterwave v4 did not return a redirect for payment method "${paymentMethod}" (next_action: ${kind}). v4 has no hosted checkout yet; see docs/FLUTTERWAVE.md.`,
          undefined,
          body,
        );
      }
      return { link: url, providerId: typeof data.id === 'string' ? data.id : undefined };
    },
    async verifyTransaction(id) {
      const safe = encodeURIComponent(String(id));
      const body = await call(`/charges/${safe}`, { method: 'GET' });
      const data = body.data as V4Charge | null | undefined;
      if (!data || typeof data !== 'object') throw new FlutterwaveError('Flutterwave returned no charge data.', undefined, body);
      return normalizeV4Charge(data);
    },
    verifyWebhook(header, rawBody) {
      const hash = o.webhookHash;
      const sig = header('flutterwave-signature') ?? '';
      if (!hash || !sig) return false;
      // Documented: base64(HMAC-SHA256(secret hash, raw body)). The same page's framework samples compare the
      // header to the secret hash directly, so that form is accepted too. Either way the order is only marked
      // paid after a fresh GET /charges/:id, so the signature only gates who can make us call the API.
      const expected = createHmac('sha256', hash).update(rawBody).digest('base64');
      return safeEqual(sig, expected) || safeEqual(sig, hash);
    },
    parseWebhook(rawBody) {
      const payload = JSON.parse(rawBody) as { type?: unknown; event?: unknown; data?: { id?: unknown; reference?: unknown } };
      const id = payload.data?.id;
      const type = typeof payload.type === 'string' ? payload.type : typeof payload.event === 'string' ? payload.event : '';
      return {
        event: type,
        transactionId: typeof id === 'number' || typeof id === 'string' ? String(id) : '',
        reference: typeof payload.data?.reference === 'string' ? payload.data.reference : '',
      };
    },
  };
}

// ---- the paid / not-paid decision (shared) --------------------------------------

export interface ExpectedOrder {
  tx_ref: string;
  amount_cents: number;
  currency: string;
}

export type PaymentVerdict = { paid: true } | { paid: false; reason: string };

/**
 * The only place that decides "paid": status must be successful and tx_ref,
 * currency and amount (>= expected, per the docs) must all match our order.
 */
export function judgePayment(order: ExpectedOrder, v: VerifiedTransaction): PaymentVerdict {
  if (String(v.status).toLowerCase() !== 'successful') return { paid: false, reason: `status is "${String(v.status)}"` };
  if (String(v.tx_ref) !== order.tx_ref) return { paid: false, reason: 'tx_ref does not match the order' };
  if (String(v.currency).toUpperCase() !== order.currency.toUpperCase()) {
    return { paid: false, reason: `currency ${String(v.currency)} does not match ${order.currency}` };
  }
  const paidCents = Math.round(Number(v.amount) * 100);
  if (!Number.isFinite(paidCents) || paidCents < order.amount_cents) {
    return { paid: false, reason: `amount ${String(v.amount)} is below ${(order.amount_cents / 100).toFixed(2)}` };
  }
  return { paid: true };
}
