/**
 * Every email trigger in one place. Each method builds the message and hands it to the
 * outbox, which never throws, so callers can notify without guarding the HTTP request.
 */
import { isDeliverableEmail } from './addresses.js';
import type { EmailRow, LeadRow, OrderRow, Store } from './db.js';
import { WAITLIST_PLATFORM } from './db.js';
import * as emails from './emails.js';
import type { IntakeAnswers } from './intake-form.js';
import type { Outbox } from './mailer.js';
import type { OrderStage } from './stages.js';

export interface NotifierOptions {
  outbox: Outbox;
  store: Store;
  publicUrl: string;
  notifyEmail: string;
  now?: () => number;
}

export type Notifier = ReturnType<typeof createNotifier>;

const ACK_REPEAT_MS = 10 * 60 * 1000;

export function createNotifier(o: NotifierOptions) {
  const { outbox } = o;
  const now = o.now ?? Date.now;
  const ctx: emails.EmailContext = { publicUrl: o.publicUrl, team: o.notifyEmail };
  const clientAddress = (email: string) => (isDeliverableEmail(email) ? email : '');

  const toTeam = (content: emails.EmailContent, kind: string, related: { type: 'order' | 'lead'; id: string | number } | undefined, replyTo: string) =>
    outbox.enqueue({ ...content, to: o.notifyEmail, kind, replyTo: replyTo || undefined, relatedType: related?.type, relatedId: related?.id });

  const toClient = (email: string, content: emails.EmailContent, kind: string, related?: { type: 'order' | 'lead'; id: string | number }) =>
    outbox.enqueue({ ...content, to: email, kind, replyTo: o.notifyEmail, relatedType: related?.type, relatedId: related?.id });

  /** The public form takes any address, so one address gets at most one acknowledgement per window. */
  const acknowledgedRecently = (kind: string, email: string) => o.store.hasRecentEmail(kind, email, now() - ACK_REPEAT_MS);

  const api = {
    /** New row from the /ship form: the team hears about it, the person gets an acknowledgement. */
    leadCreated(lead: LeadRow): void {
      const related = { type: 'lead' as const, id: lead.id };
      if (lead.platform === WAITLIST_PLATFORM) {
        toTeam(emails.waitlistInternal(ctx, lead), 'waitlist_new', related, clientAddress(lead.email));
        if (!acknowledgedRecently('waitlist_ack', lead.email)) toClient(lead.email, emails.waitlistAck(ctx), 'waitlist_ack', related);
        return;
      }
      toTeam(emails.leadInternal(ctx, lead), 'lead_new', related, clientAddress(lead.email));
      if (!acknowledgedRecently('lead_ack', lead.email)) toClient(lead.email, emails.leadAck(ctx, lead), 'lead_ack', related);
    },

    /** Called once, when an order first verifies as paid. */
    orderPaid(order: OrderRow): void {
      const email = clientAddress(order.email);
      const related = { type: 'order' as const, id: order.id };
      toTeam(emails.orderPaidInternal(ctx, order, email), 'order_paid', related, email);
      if (email) toClient(email, emails.orderReceipt(ctx, order), 'order_receipt', related);
    },

    paymentFailed(order: OrderRow, reason: string): void {
      const email = clientAddress(order.email);
      toTeam(emails.paymentFailedInternal(ctx, order, email, reason), 'payment_failed', { type: 'order', id: order.id }, email);
    },

    intakeSubmitted(order: OrderRow, intake: IntakeAnswers, updated: boolean): void {
      toTeam(emails.intakeInternal(ctx, order, intake, updated), 'intake', { type: 'order', id: order.id }, clientAddress(order.email));
    },

    clientMessage(order: OrderRow, message: string): void {
      toTeam(emails.clientMessageInternal(ctx, order, message), 'client_message', { type: 'order', id: order.id }, clientAddress(order.email));
    },

    /** Stage change and/or client-visible update from the team. Returns the outbox row, if one was recorded. */
    clientUpdate(order: OrderRow, u: { stage?: OrderStage; text?: string }): EmailRow | undefined {
      const email = clientAddress(order.email);
      if (!email) return undefined;
      return toClient(email, emails.orderUpdate(ctx, order, u), 'order_update', { type: 'order', id: order.id });
    },

    /** Sends the private link(s) for `orders` to `email` (find-my-order, and "resend link" in the admin). */
    orderLinks(email: string, orders: OrderRow[]): EmailRow | undefined {
      if (!isDeliverableEmail(email) || orders.length === 0) return undefined;
      return toClient(email, emails.orderLinks(ctx, orders), 'order_links', orders.length === 1 && orders[0] ? { type: 'order', id: orders[0].id } : undefined);
    },

    test(): EmailRow | undefined {
      return outbox.enqueue({ ...emails.testEmail(ctx, now()), to: o.notifyEmail, kind: 'test' });
    },

    /** True when a links email went to this address in the last `windowMs` (stops repeat requests from flooding an inbox). */
    recentlySentLinks(email: string, windowMs: number): boolean {
      return o.store.hasRecentEmail('order_links', email, now() - windowMs);
    },
  };

  // A notification must never break the request that triggered it: log and carry on.
  for (const key of Object.keys(api) as Array<keyof typeof api>) {
    const fn = api[key] as (...args: unknown[]) => unknown;
    (api as Record<string, unknown>)[key] = (...args: unknown[]) => {
      try {
        return fn(...args);
      } catch (err) {
        console.error(`[notify] ${key} failed:`, err);
        return undefined;
      }
    };
  }
  return api;
}
