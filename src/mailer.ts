/**
 * Outgoing mail. Every message goes through the `emails` table first (the outbox),
 * so a request never waits on SMTP and never fails because of it:
 *
 *   enqueue()  -> row `queued` (or `skipped` when SMTP is not configured)
 *   worker     -> runs after each enqueue and every 60 s; sends, records the result,
 *                 retries with backoff up to MAX_ATTEMPTS, then marks the row `failed`
 *
 * The transport is an interface so tests inject a fake one (no network).
 */
import { createTransport } from 'nodemailer';
import { isDeliverableEmail } from './addresses.js';
import type { SmtpConfig } from './config.js';
import type { EmailRow, Store } from './db.js';

export interface MailMessage {
  from: { name: string; address: string };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /** Outbox `kind`, e.g. `order_receipt`. Transports may use it for headers. */
  kind: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export interface EnqueueInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
  replyTo?: string;
  relatedType?: 'order' | 'lead';
  relatedId?: string | number;
}

export const MAX_ATTEMPTS = 5;
/** Wait before attempt 2, 3, 4 and 5. */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const SKIP_NOT_CONFIGURED = 'SMTP is not configured';
export const SKIP_UNDELIVERABLE = 'no deliverable address (placeholder or invalid)';
/** Kinds sent with low priority headers. */
const LOW_PRIORITY_KINDS = new Set(['payment_failed']);

export interface OutboxOptions {
  store: Store;
  from: { name: string; address: string };
  /** Undefined means "SMTP is not configured": rows are recorded as `skipped`. */
  transport?: MailTransport;
  now?: () => number;
  log?: (message: string) => void;
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function errorText(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown; responseCode?: unknown } | undefined;
  const parts = [e?.code, e?.responseCode, e?.message ?? String(err)].filter((p) => p !== undefined && p !== '');
  return oneLine(parts.map(String).join(' '), 500);
}

export class Outbox {
  private readonly store: Store;
  private readonly from: { name: string; address: string };
  private readonly transport: MailTransport | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(o: OutboxOptions) {
    this.store = o.store;
    this.from = o.from;
    this.transport = o.transport;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(m));
  }

  /** True when queued mail will actually be sent. */
  get configured(): boolean {
    return Boolean(this.transport);
  }

  /**
   * Records a message for delivery. Never throws and never waits on the network:
   * a storage or validation problem is logged and reported as `undefined`.
   */
  enqueue(input: EnqueueInput): EmailRow | undefined {
    try {
      const to = oneLine(input.to ?? '', 254);
      if (!to) return undefined;
      const deliverable = isDeliverableEmail(to);
      const replyTo = input.replyTo && isDeliverableEmail(input.replyTo) ? input.replyTo : '';
      const skip = !deliverable ? SKIP_UNDELIVERABLE : !this.transport ? SKIP_NOT_CONFIGURED : null;
      const row = this.store.insertEmail({
        to_addr: to,
        reply_to: replyTo,
        subject: oneLine(input.subject, 200),
        kind: input.kind,
        status: skip ? 'skipped' : 'queued',
        last_error: skip,
        related_type: input.relatedType ?? null,
        related_id: input.relatedId === undefined ? null : String(input.relatedId),
        body_text: input.text,
        body_html: input.html,
      });
      if (!skip) this.kick();
      return row;
    } catch (err) {
      this.log(`[mail] could not enqueue ${input.kind}: ${errorText(err)}`);
      return undefined;
    }
  }

  /** Schedules a worker pass without making the caller wait for it. */
  kick(): void {
    setImmediate(() => void this.flush());
  }

  /** Runs one worker pass after any pass already in flight. Resolves when the queue has nothing due. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.drain()).catch((err) => this.log(`[mail] worker error: ${errorText(err)}`));
    return this.chain;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const due = this.store.dueEmails(20);
      if (due.length === 0) return;
      for (const row of due) await this.deliver(row);
    }
  }

  private async deliver(row: EmailRow): Promise<void> {
    if (!this.transport) {
      this.store.markEmailSkipped(row.id, SKIP_NOT_CONFIGURED);
      return;
    }
    try {
      await this.transport.send({
        from: this.from,
        to: row.to_addr,
        replyTo: row.reply_to || undefined,
        subject: row.subject,
        text: row.body_text,
        html: row.body_html,
        kind: row.kind,
      });
      this.store.markEmailSent(row.id);
    } catch (err) {
      const attempt = row.attempts + 1;
      const wait = attempt >= MAX_ATTEMPTS ? undefined : (RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
      const message = errorText(err);
      this.store.markEmailAttemptFailed(row.id, message, wait === undefined ? undefined : this.now() + wait);
      this.log(`[mail] ${row.kind} #${row.id} attempt ${attempt}/${MAX_ATTEMPTS} failed${wait === undefined ? ', giving up' : ''}: ${message}`);
    }
  }

  /** Starts the periodic worker (also picks up mail left queued by a previous run). */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** SMTP via nodemailer: implicit TLS on 465, otherwise STARTTLS (required unless the port is 25). */
export function createSmtpTransport(smtp: SmtpConfig): MailTransport {
  const transporter = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: smtp.requireTLS,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(m) {
      await transporter.sendMail({
        from: m.from,
        to: m.to,
        replyTo: m.replyTo,
        subject: m.subject,
        text: m.text,
        html: m.html,
        priority: LOW_PRIORITY_KINDS.has(m.kind) ? 'low' : undefined,
      });
    },
  };
}
