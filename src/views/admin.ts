import type { LeadRow, OrderRow } from '../db.js';
import { SITE_NAME, esc, layout } from './html.js';
import { formatAmount } from './pay.js';

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function ordersTable(orders: OrderRow[]): string {
  if (orders.length === 0) return '<p class="dim">No orders yet.</p>';
  return `<div class="table-wrap"><table class="table">
<thead><tr><th>When</th><th>Status</th><th>Plan</th><th>Amount</th><th>Email</th><th>Order</th><th>FLW id</th></tr></thead>
<tbody>${orders
    .map(
      (o) => `<tr>
<td class="mono">${when(o.created_at)}</td>
<td><span class="status status-${esc(o.status)}">${esc(o.status)}</span></td>
<td>${esc(o.plan)}</td>
<td class="mono">${formatAmount(o.amount_cents, o.currency)}</td>
<td>${esc(o.email)}</td>
<td class="mono">${esc(o.id)}</td>
<td class="mono">${esc(o.flw_id ?? '')}</td>
</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function leadsTable(leads: LeadRow[]): string {
  if (leads.length === 0) return '<p class="dim">No leads yet.</p>';
  return `<div class="table-wrap"><table class="table">
<thead><tr><th>When</th><th>Name</th><th>Email</th><th>Package</th><th>Repo</th><th>Message</th></tr></thead>
<tbody>${leads
    .map(
      (l) => `<tr>
<td class="mono">${when(l.created_at)}</td>
<td>${esc(l.name)}</td>
<td>${esc(l.email)}</td>
<td>${esc(l.platform)}</td>
<td>${l.repo_url ? `<a class="inline" href="${esc(l.repo_url)}" rel="noopener noreferrer">${esc(l.repo_url.replace(/^https?:\/\//, ''))}</a>` : ''}</td>
<td class="cell-wrap">${esc(l.message)}${l.store_links ? `<br><span class="dim">${esc(l.store_links)}</span>` : ''}</td>
</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

export function renderAdmin(o: { orders: OrderRow[]; leads: LeadRow[]; paymentsEnabled: boolean }): string {
  const paid = o.orders.filter((x) => x.status === 'paid');
  const revenue = paid.reduce((n, x) => n + x.amount_cents, 0);
  const body = `<section class="container page-simple admin">
  <p class="eyebrow">Admin</p>
  <h1>Orders and leads.</h1>
  <p class="lead">${o.orders.length} order${o.orders.length === 1 ? '' : 's'} (${paid.length} paid, ${formatAmount(revenue, paid[0]?.currency ?? 'USD')} collected), ${o.leads.length} lead${o.leads.length === 1 ? '' : 's'}. Hosted checkout is ${o.paymentsEnabled ? 'enabled' : 'off (FLW_SECRET_KEY unset)'}.</p>
  <h2 class="admin-h2">Orders</h2>
  ${ordersTable(o.orders)}
  <h2 class="admin-h2">Leads</h2>
  ${leadsTable(o.leads)}
</section>`;
  return layout({ title: `Admin — ${SITE_NAME}`, description: 'Orders and leads.', noindex: true, body });
}
