import type { OrderRow } from '../db.js';
import { SITE_NAME, esc, layout } from './html.js';
import { INTAKE_CHECKLIST } from './intake.js';
import type { Tier } from './ship.js';

export function formatAmount(cents: number, currency: string): string {
  const major = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  return currency.toUpperCase() === 'USD' ? `$${major}` : `${major} ${esc(currency.toUpperCase())}`;
}

function orderMeta(order: OrderRow, tier: Tier | undefined): string {
  return `<dl class="order-meta">
    <div><dt>Package</dt><dd>${esc(tier?.name ?? order.plan)}</dd></div>
    <div><dt>Amount</dt><dd>${formatAmount(order.amount_cents, order.currency)}</dd></div>
    <div><dt>Order</dt><dd><code>${esc(order.id)}</code></dd></div>
    ${order.email && !isPlaceholderEmail(order.email) ? `<div><dt>Email</dt><dd>${esc(order.email)}</dd></div>` : ''}
  </dl>`;
}

/** Placeholder we send to Flutterwave when the buyer left the email field empty. */
export function placeholderEmail(orderId: string, publicUrl: string): string {
  let host = 'storelint.embracetech.org';
  try {
    host = new URL(publicUrl).hostname || host;
  } catch {
    /* keep default */
  }
  return `orders+${orderId}@${host}`;
}

export function isPlaceholderEmail(email: string): boolean {
  return /^orders\+sl_[0-9a-f]+@/i.test(email);
}

export function renderChecklist(): string {
  return INTAKE_CHECKLIST.map(
    (g) => `<div class="card checklist-group">
    <h3>${esc(g.title)}</h3>
    <ul class="tick-list">${g.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
  </div>`,
  ).join('\n');
}

export function renderPaid(o: { order: OrderRow; tier: Tier | undefined }): string {
  const noEmail = !o.order.email || isPlaceholderEmail(o.order.email);
  const body = `<section class="container narrow page-simple">
  <p class="eyebrow">Payment received</p>
  <h1>Thanks. Let&rsquo;s get it shipped.</h1>
  <p class="lead">We&rsquo;ll email you within 24 hours with the intake checklist and where to send everything. The 48-hour clock starts once we have the items below.</p>
  ${orderMeta(o.order, o.tier)}
  ${
    noEmail
      ? `<p class="notice">We did not get an email address with this payment. <a class="inline" href="/ship?plan=${esc(o.order.plan)}#lead">Send us a note</a> quoting order <code>${esc(o.order.id)}</code> so we know where to reach you.</p>`
      : ''
  }
  <div class="actions"><a class="btn btn-primary" href="#checklist">See the intake checklist</a> <a class="btn btn-secondary" href="/">Back to ${SITE_NAME}</a></div>
</section>
<section class="section" id="checklist">
  <div class="container">
    <div class="section-head tight">
      <span class="eyebrow">Intake checklist</span>
      <h2>What we need from you.</h2>
      <p class="lead">Send everything in one message or shared folder. Items marked (Play) or (Apple) apply to that store only. Never send keys, passwords or .env values in chat; use a password-manager share or an encrypted file.</p>
    </div>
    <div class="grid grid-3">
      ${renderChecklist()}
    </div>
  </div>
</section>`;
  return layout({ title: `Payment received — ${SITE_NAME}`, description: 'Payment received. Intake checklist.', noindex: true, body });
}

export function renderRetry(o: { order: OrderRow; tier: Tier | undefined; status: 'failed' | 'cancelled' | 'pending'; reason?: string }): string {
  const cancelled = o.status === 'cancelled';
  const title = cancelled ? 'Payment cancelled.' : o.status === 'pending' ? 'Payment still pending.' : 'Payment did not go through.';
  const lead = cancelled
    ? 'Nothing was charged. You can try again whenever you are ready, or send the request form and pay later.'
    : o.status === 'pending'
      ? 'Flutterwave has not confirmed this payment yet. If you completed it, refresh in a minute; we also update the order automatically when the confirmation arrives.'
      : 'Nothing was delivered and no work starts until a payment verifies. If you were charged, the amount is refunded automatically by the card network; reply to the Flutterwave receipt if it is not.';
  const body = `<section class="container narrow page-simple">
  <p class="eyebrow">${cancelled ? 'Cancelled' : o.status === 'pending' ? 'Pending' : 'Not completed'}</p>
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(lead)}</p>
  ${orderMeta(o.order, o.tier)}
  ${o.reason ? `<p class="small dim">Details: ${esc(o.reason)}.</p>` : ''}
  <div class="actions">
    <form method="post" action="/pay/${esc(o.order.plan)}" data-busy="Opening checkout…">
      <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="email" value="${esc(isPlaceholderEmail(o.order.email) ? '' : o.order.email)}">
      <button type="submit" class="btn btn-primary">Try again${o.tier ? ` (${esc(o.tier.price)})` : ''}</button>
    </form>
    <a class="btn btn-secondary" href="/ship?plan=${esc(o.order.plan)}#lead">Request without paying</a>
  </div>
</section>`;
  return layout({ title: `${title} — ${SITE_NAME}`, description: lead, noindex: true, body });
}

export function renderPayError(o: { tier: Tier | undefined; detail?: string }): string {
  const body = `<section class="container narrow page-simple">
  <p class="eyebrow">Checkout unavailable</p>
  <h1>We couldn&rsquo;t open the payment page.</h1>
  <p class="lead">The payment provider did not accept the request, so nothing was charged. Try again in a minute, or send the request form and we will invoice you instead.</p>
  ${o.detail ? `<p class="small dim">Provider said: ${esc(o.detail)}</p>` : ''}
  <div class="actions">
    <a class="btn btn-primary" href="/ship?plan=${esc(o.tier?.key ?? 'both')}#prices">Back to packages</a>
    <a class="btn btn-secondary" href="/ship?plan=${esc(o.tier?.key ?? 'both')}#lead">Request without paying</a>
  </div>
</section>`;
  return layout({ title: `Checkout unavailable — ${SITE_NAME}`, description: 'Checkout unavailable.', noindex: true, body });
}
