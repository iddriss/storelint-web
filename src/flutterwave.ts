/**
 * Minimal Flutterwave v3 client (fetch only, no SDK).
 * Docs: https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1,
 *       https://developer.flutterwave.com/docs/transaction-verification,
 *       https://developer.flutterwave.com/docs/webhooks  (see docs/FLUTTERWAVE.md)
 */

export interface FlutterwaveClientOptions {
  secretKey: string;
  apiBase: string;
  fetch?: typeof fetch;
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
  /** POST /payments -> hosted checkout link. */
  createPayment(req: CreatePaymentRequest): Promise<string>;
  /** GET /transactions/:id/verify -> data. */
  verifyTransaction(id: string | number): Promise<VerifiedTransaction>;
}

interface Envelope {
  status?: string;
  message?: string;
  data?: unknown;
}

export function createFlutterwaveClient(o: FlutterwaveClientOptions): FlutterwaveClient {
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const headers = {
    Authorization: `Bearer ${o.secretKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function call(path: string, init: RequestInit): Promise<Envelope> {
    let res: Response;
    try {
      res = await doFetch(`${o.apiBase}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new FlutterwaveError(`Could not reach Flutterwave: ${err instanceof Error ? err.message : String(err)}`);
    }
    let body: Envelope | undefined;
    try {
      body = (await res.json()) as Envelope;
    } catch {
      body = undefined;
    }
    if (!res.ok || body?.status !== 'success') {
      const msg = body?.message ? String(body.message) : `HTTP ${res.status}`;
      throw new FlutterwaveError(`Flutterwave error: ${msg}`, res.status, body);
    }
    return body;
  }

  return {
    async createPayment(req) {
      const body = await call('/payments', { method: 'POST', body: JSON.stringify(req) });
      const link = (body.data as { link?: unknown } | undefined)?.link;
      if (typeof link !== 'string' || !/^https:\/\//i.test(link)) {
        throw new FlutterwaveError('Flutterwave did not return a hosted payment link.', undefined, body);
      }
      return link;
    },
    async verifyTransaction(id) {
      const safe = encodeURIComponent(String(id));
      const body = await call(`/transactions/${safe}/verify`, { method: 'GET' });
      const data = body.data as VerifiedTransaction | null | undefined;
      if (!data || typeof data !== 'object') throw new FlutterwaveError('Flutterwave returned no transaction data.', undefined, body);
      return data;
    },
  };
}

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
