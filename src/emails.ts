/**
 * Email bodies. Each message is described once as a list of blocks and rendered twice:
 * plain text, and a small HTML version with inline styles only (no remote images, no web
 * fonts, no scripts) so it survives every client.
 */
import type { LeadRow, OrderRow } from './db.js';
import type { IntakeAnswers } from './intake-form.js';
import { intakeSummary } from './intake-form.js';
import { PLATFORM_LABELS } from './leads.js';
import type { PlatformChoice } from './leads.js';
import type { OrderStage } from './stages.js';
import { STAGE_HEADLINES, nextSteps } from './stages.js';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

type Block =
  | { p: string }
  | { rows: Array<[label: string, value: string]> }
  | { quote: string }
  | { list: string[] }
  | { button: { label: string; url: string } }
  | { small: string };

function h(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const multiline = (value: string) => h(value).replace(/\n/g, '<br>');

function blockText(b: Block): string {
  if ('p' in b) return b.p;
  if ('rows' in b) return b.rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v.includes('\n') ? `\n  ${v.replace(/\n/g, '\n  ')}` : v}`).join('\n');
  if ('quote' in b) return b.quote.split('\n').map((l) => `> ${l}`).join('\n');
  if ('list' in b) return b.list.map((l) => `- ${l}`).join('\n');
  if ('button' in b) return `${b.button.label}:\n${b.button.url}`;
  return b.small;
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function blockHtml(b: Block): string {
  if ('p' in b) return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a">${multiline(b.p)}</p>`;
  if ('rows' in b) {
    const rows = b.rows
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 16px 6px 0;font-size:13px;color:#71717a;vertical-align:top;white-space:nowrap">${h(k)}</td><td style="padding:6px 0;font-size:14px;line-height:1.5;color:#18181b;word-break:break-word">${multiline(v)}</td></tr>`,
      )
      .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse">${rows}</table>`;
  }
  if ('quote' in b) return `<div style="margin:0 0 16px;padding:12px 14px;border-left:3px solid #d4d4d8;background:#f4f4f5;font-size:14px;line-height:1.6;color:#27272a;word-break:break-word">${multiline(b.quote)}</div>`;
  if ('list' in b) return `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;color:#27272a">${b.list.map((l) => `<li style="margin:0 0 6px">${h(l)}</li>`).join('')}</ul>`;
  if ('button' in b) {
    return `<p style="margin:4px 0 8px"><a href="${h(b.button.url)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#09090b;color:#fafafa;font-size:14px;font-weight:600;text-decoration:none">${h(b.button.label)}</a></p>
<p style="margin:0 0 16px;font-size:12px;line-height:1.5;color:#71717a;word-break:break-all">${h(b.button.url)}</p>`;
  }
  return `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#71717a">${multiline(b.small)}</p>`;
}

export function compose(o: { subject: string; heading: string; blocks: Block[]; footer: string }): EmailContent {
  const text = [o.heading, '', ...o.blocks.flatMap((b) => [blockText(b), '']), '-- ', o.footer].join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(o.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;${FONT}"><tr><td style="padding:28px 28px 12px">
<p style="margin:0 0 18px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#71717a">StoreLint</p>
<h1 style="margin:0 0 18px;font-size:21px;line-height:1.3;font-weight:600;color:#09090b">${h(o.heading)}</h1>
${o.blocks.map(blockHtml).join('\n')}
</td></tr><tr><td style="padding:14px 28px 22px;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.5;color:#71717a">${multiline(o.footer)}</td></tr></table>
</td></tr></table>
</body></html>`;
  return { subject: o.subject, text, html };
}

// ---- shared bits ---------------------------------------------------------------

export interface EmailContext {
  /** Public origin without a trailing slash. */
  publicUrl: string;
  /** Team address: internal notifications go here and clients are told to invite it. */
  team: string;
}

const PLAN_NAMES: Record<string, string> = { play: 'Google Play', ios: 'App Store', both: 'Both stores', fix: 'Fix a rejection' };
export const planName = (plan: string) => PLAN_NAMES[plan] ?? plan;

export function money(cents: number, currency: string): string {
  const major = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  return currency.toUpperCase() === 'USD' ? `$${major}` : `${major} ${currency.toUpperCase()}`;
}

export const clientOrderUrl = (ctx: EmailContext, o: Pick<OrderRow, 'id' | 'access_token'>) => `${ctx.publicUrl}/o/${o.id}/${o.access_token}`;
export const adminOrderUrl = (ctx: EmailContext, orderId: string) => `${ctx.publicUrl}/admin/orders/${orderId}`;
export const adminLeadUrl = (ctx: EmailContext, leadId: number) => `${ctx.publicUrl}/admin/leads/${leadId}`;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clientFooter = (ctx: EmailContext) => `StoreLint release ops · ${ctx.publicUrl.replace(/^https?:\/\//, '')}\nReply to this email to reach a developer (${ctx.team}).`;
const internalFooter = (ctx: EmailContext) => `Internal notification from ${ctx.publicUrl.replace(/^https?:\/\//, '')}/admin`;
const PRIVATE_LINK_NOTE = 'Keep this link private: anyone who has it can see and update your order. No account or password is needed.';

function orderRows(o: OrderRow): Array<[string, string]> {
  return [
    ['Package', planName(o.plan)],
    ['Amount', money(o.amount_cents, o.currency)],
    ['Order', o.id],
    ['Paid on', o.paid_at ? day(o.paid_at) : ''],
    ['Payment reference', o.flw_id ?? ''],
  ];
}

// ---- internal notifications ----------------------------------------------------

export function leadInternal(ctx: EmailContext, lead: LeadRow): EmailContent {
  const pkg = PLATFORM_LABELS[lead.platform as PlatformChoice] ?? lead.platform;
  return compose({
    subject: `New lead: ${lead.name} (${pkg})`,
    heading: 'New service lead',
    blocks: [
      { rows: [['Name', lead.name], ['Email', lead.email], ['Package', pkg], ['Repository', lead.repo_url], ['Store links', lead.store_links]] },
      ...(lead.message ? [{ quote: lead.message }] : []),
      { button: { label: 'Open the lead', url: adminLeadUrl(ctx, lead.id) } },
      { small: 'The lead was told a developer replies within one business day. Replying to this email goes to them.' },
    ],
    footer: internalFooter(ctx),
  });
}

export function waitlistInternal(ctx: EmailContext, lead: LeadRow): EmailContent {
  return compose({
    subject: `Deep scan waitlist: ${lead.email}`,
    heading: 'New deep-scan waitlist signup',
    blocks: [{ rows: [['Email', lead.email]] }, { button: { label: 'Open the waitlist', url: `${ctx.publicUrl}/admin?tab=waitlist` } }],
    footer: internalFooter(ctx),
  });
}

export function orderPaidInternal(ctx: EmailContext, o: OrderRow, clientEmail: string): EmailContent {
  return compose({
    subject: `Order paid: ${planName(o.plan)} ${money(o.amount_cents, o.currency)}${clientEmail ? ` (${clientEmail})` : ''}`,
    heading: 'An order was paid',
    blocks: [
      { rows: [...orderRows(o), ['Client email', clientEmail || '(none given: add one on the order page)']] },
      { button: { label: 'Open the order', url: adminOrderUrl(ctx, o.id) } },
      { small: clientEmail ? 'The client got a receipt with their private order link and was asked to fill in the intake.' : 'No receipt was sent because the order has no usable email address.' },
    ],
    footer: internalFooter(ctx),
  });
}

export function paymentFailedInternal(ctx: EmailContext, o: OrderRow, clientEmail: string, reason: string): EmailContent {
  return compose({
    subject: `Payment failed: ${planName(o.plan)} ${money(o.amount_cents, o.currency)}${clientEmail ? ` (${clientEmail})` : ''}`,
    heading: 'A payment verified as failed',
    blocks: [
      { rows: [['Package', planName(o.plan)], ['Amount', money(o.amount_cents, o.currency)], ['Order', o.id], ['Client email', clientEmail], ['Reason', reason]] },
      { button: { label: 'Open the order', url: adminOrderUrl(ctx, o.id) } },
      { small: 'Low priority. Nothing was delivered; the buyer saw a retry page.' },
    ],
    footer: internalFooter(ctx),
  });
}

export function intakeInternal(ctx: EmailContext, o: OrderRow, intake: IntakeAnswers, updated: boolean): EmailContent {
  return compose({
    subject: `Intake ${updated ? 'updated' : 'submitted'}: ${intake.app_name} (${o.id})`,
    heading: updated ? 'A client updated their intake' : 'A client submitted their intake',
    blocks: [
      { rows: [['Order', o.id], ['Package', planName(o.plan)], ...intakeSummary(intake)] },
      { button: { label: 'Open the order', url: adminOrderUrl(ctx, o.id) } },
    ],
    footer: internalFooter(ctx),
  });
}

export function clientMessageInternal(ctx: EmailContext, o: OrderRow, message: string): EmailContent {
  return compose({
    subject: `Client message on ${o.id} (${planName(o.plan)})`,
    heading: 'A client sent a message',
    blocks: [{ quote: message }, { rows: [['Order', o.id], ['Package', planName(o.plan)]] }, { button: { label: 'Open the order', url: adminOrderUrl(ctx, o.id) } }],
    footer: internalFooter(ctx),
  });
}

export function testEmail(ctx: EmailContext, sentAt: number): EmailContent {
  return compose({
    subject: 'StoreLint test email',
    heading: 'Outgoing mail works',
    blocks: [{ p: `This test message was queued from the admin dashboard at ${new Date(sentAt).toISOString()}.` }, { button: { label: 'Open the email log', url: `${ctx.publicUrl}/admin?tab=emails` } }],
    footer: internalFooter(ctx),
  });
}

// ---- client emails -------------------------------------------------------------

export function leadAck(ctx: EmailContext, lead: LeadRow): EmailContent {
  const pkg = PLATFORM_LABELS[lead.platform as PlatformChoice] ?? lead.platform;
  const first = lead.name && !lead.name.startsWith('(') ? ` ${lead.name.split(/\s+/)[0]}` : '';
  return compose({
    subject: 'We received your request',
    heading: `Thanks${first}, we received your request.`,
    blocks: [
      { p: 'A developer replies within one business day with a confirmed scope and the next steps. Nothing is charged until you decide to go ahead.' },
      { rows: [['Package', pkg], ['Repository', lead.repo_url]] },
      { p: 'If you have a StoreLint report link or the rejection message from the store, reply to this email with it. Please do not send passwords or keys by email.' },
    ],
    footer: clientFooter(ctx),
  });
}

export function waitlistAck(ctx: EmailContext): EmailContent {
  return compose({
    subject: 'You are on the StoreLint deep-scan waitlist',
    heading: 'You are on the list.',
    blocks: [{ p: 'We will email you once binary deep scans (AAB and IPA) are live. Nothing else will be sent to this address.' }],
    footer: clientFooter(ctx),
  });
}

export function orderReceipt(ctx: EmailContext, o: OrderRow): EmailContent {
  return compose({
    subject: `Receipt and next steps: ${planName(o.plan)} (${money(o.amount_cents, o.currency)})`,
    heading: 'Payment received. Here is what happens next.',
    blocks: [
      { rows: orderRows(o) },
      { p: 'Your private order page shows progress and is where you send us what we need:' },
      { button: { label: 'Open your order page', url: clientOrderUrl(ctx, o) } },
      { list: nextSteps('paid', { plan: o.plan, team: ctx.team }) },
      { small: PRIVATE_LINK_NOTE },
    ],
    footer: clientFooter(ctx),
  });
}

export function orderUpdate(ctx: EmailContext, o: OrderRow, u: { stage?: OrderStage; text?: string }): EmailContent {
  const heading = u.stage ? STAGE_HEADLINES[u.stage] : 'There is a new update on your order.';
  const blocks: Block[] = [];
  if (u.text) blocks.push({ quote: u.text });
  if (u.stage) blocks.push({ list: nextSteps(u.stage, { plan: o.plan, team: ctx.team }) });
  blocks.push({ button: { label: 'Open your order page', url: clientOrderUrl(ctx, o) } }, { rows: [['Order', o.id], ['Package', planName(o.plan)]] }, { small: PRIVATE_LINK_NOTE });
  return compose({ subject: `StoreLint order update: ${heading.replace(/\.$/, '')}`, heading, blocks, footer: clientFooter(ctx) });
}

export function orderLinks(ctx: EmailContext, orders: OrderRow[]): EmailContent {
  const many = orders.length > 1;
  return compose({
    subject: many ? 'Your StoreLint order links' : 'Your StoreLint order link',
    heading: many ? 'Here are your order pages.' : 'Here is your order page.',
    blocks: [
      ...orders.map((o): Block => ({ button: { label: `${planName(o.plan)} · ${money(o.amount_cents, o.currency)} · ${o.id}`, url: clientOrderUrl(ctx, o) } })),
      { small: PRIVATE_LINK_NOTE },
      { small: 'You are getting this because the link was requested for this address. If that was not you, you can ignore this email.' },
    ],
    footer: clientFooter(ctx),
  });
}
