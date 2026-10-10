import { isPlaceholderEmail } from '../addresses.js';
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

export function renderChecklist(): string {
  return INTAKE_CHECKLIST.map(
    (g) => `<div class="card checklist-group">
    <h3>${esc(g.title)}</h3>
    <ul class="tick-list">${g.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
  </div>`,
  ).join('\n');
}

/**
 * Shown on /pay/return for a paid order when this browser cannot be tied to the checkout
 * (no checkout cookie and the payment is not fresh). It confirms the payment without
 * revealing the private order link; the link travels by email only.
 */
export function renderPaid(o: { order: OrderRow; tier: Tier | undefined; emailEnabled: boolean; team: string }): string {
  const hasEmail = Boolean(o.order.email) && !isPlaceholderEmail(o.order.email);
  const lead =
    o.emailEnabled && hasEmail
      ? 'Your receipt and the link to your private order page were emailed to the address on this order. The intake form and progress updates live on that page.'
      : `This order is paid. Your private order page link is not shown here for your security: write to ${o.team} quoting the order number below and we will send it to you.`;
  const body = `<section class="container narrow page-simple">
  <p class="eyebrow">Payment received</p>
  <h1>Thanks. This order is paid.</h1>
  <p class="lead">${esc(lead)}</p>
  ${orderMeta(o.order, o.tier)}
  <div class="actions">${o.emailEnabled ? '<a class="btn btn-primary" href="/orders/find">Email me my order link</a> ' : ''}<a class="btn btn-secondary" href="/">Back to ${SITE_NAME}</a></div>
</section>`;
  return layout({ title: `Payment received — ${SITE_NAME}`, description: 'Payment received.', noindex: true, noReferrer: true, body });
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

export { isPlaceholderEmail, placeholderEmail } from '../addresses.js';
