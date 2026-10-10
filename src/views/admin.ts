import { isPlaceholderEmail } from '../addresses.js';
import type { EmailRow, LeadRow, OrderEventRow, OrderRow, RevenueRow } from '../db.js';
import { EMAIL_STATUSES, LEAD_STATUSES, ORDER_STATUSES } from '../db.js';
import type { IntakeAnswers } from '../intake-form.js';
import { intakeSummary } from '../intake-form.js';
import { PLATFORM_LABELS } from '../leads.js';
import type { PlatformChoice } from '../leads.js';
import { ADMIN_STAGE_LABELS, ORDER_STAGES, isOrderStage } from '../stages.js';
import { SITE_NAME, esc, escLines, layout, when } from './html.js';
import { renderTimeline } from './order.js';
import { formatAmount } from './pay.js';
import { TIERS, findTier } from './ship.js';

export const ADMIN_TABS = ['orders', 'leads', 'waitlist', 'emails'] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/** Flash keys carried in `?flash=`. Only these fixed strings are ever rendered. */
const FLASHES: Record<string, { text: string; tone: 'ok' | 'error' }> = {
  'stage-set': { text: 'Stage updated. The client is being emailed.', tone: 'ok' },
  'stage-set-noemail': { text: 'Stage updated and shown on the client page. No email went out: SMTP is not configured, or the order has no usable address.', tone: 'ok' },
  'stage-same': { text: 'The order is already in that stage.', tone: 'error' },
  'stage-invalid': { text: 'Pick a valid stage.', tone: 'error' },
  'reason-required': { text: 'Say what the client needs to do: the reason is shown to them.', tone: 'error' },
  'not-paid': { text: 'Only paid orders have a stage.', tone: 'error' },
  'update-posted': { text: 'Update posted to the client page. The client is being emailed.', tone: 'ok' },
  'update-posted-noemail': { text: 'Update posted to the client page. No email went out: SMTP is not configured, or the order has no usable address.', tone: 'ok' },
  'note-added': { text: 'Internal note added. The client never sees it.', tone: 'ok' },
  'empty': { text: 'Write something first.', tone: 'error' },
  'link-sent': { text: 'Order link queued for the client. Check the email log for delivery.', tone: 'ok' },
  'link-skipped': { text: 'The link email was recorded as skipped: SMTP is not configured on this server.', tone: 'error' },
  'no-email': { text: 'This order has no usable client email. Add one first.', tone: 'error' },
  'email-saved': { text: 'Client email saved.', tone: 'ok' },
  'email-invalid': { text: 'Enter a valid email address.', tone: 'error' },
  'email-locked': { text: 'The order already has a client email.', tone: 'error' },
  'cancelled': { text: 'Order marked cancelled.', tone: 'ok' },
  'lead-saved': { text: 'Lead saved.', tone: 'ok' },
  'test-queued': { text: 'Test email queued. Its status shows in the log below within a few seconds.', tone: 'ok' },
  'test-skipped': { text: 'Test email recorded as skipped: SMTP is not configured on this server.', tone: 'error' },
  'retry-queued': { text: 'Message put back in the queue.', tone: 'ok' },
  'signed-out': { text: 'Signed out.', tone: 'ok' },
};

function flash(key: string | undefined): string {
  const f = key ? FLASHES[key] : undefined;
  return f ? `<p class="flash flash-${f.tone}" role="status">${esc(f.text)}</p>` : '';
}

const csrfField = (csrf: string) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

function shell(o: { title: string; eyebrow: string; heading: string; csrf: string; back?: { href: string; label: string }; body: string; flash?: string }): string {
  const body = `<section class="container page-admin">
  <div class="admin-bar">
    <div class="admin-bar-title">
      <p class="eyebrow">${o.back ? `<a href="${esc(o.back.href)}">&larr; ${esc(o.back.label)}</a>` : esc(o.eyebrow)}</p>
      <h1>${esc(o.heading)}</h1>
    </div>
    <div class="admin-bar-actions">
      <a class="btn btn-secondary btn-sm" href="/admin">Dashboard</a>
      <form method="post" action="/admin/logout">${csrfField(o.csrf)}<button type="submit" class="btn btn-secondary btn-sm">Log out</button></form>
    </div>
  </div>
  ${flash(o.flash)}
  ${o.body}
</section>`;
  return layout({ title: `${o.title} — ${SITE_NAME} admin`, description: 'Admin.', noindex: true, noReferrer: true, body });
}

// ---- login ---------------------------------------------------------------------

export function renderAdminLogin(o: { error?: string; flash?: string } = {}): string {
  const body = `<section class="container page-simple login">
  <p class="eyebrow">Admin</p>
  <h1>Sign in.</h1>
  ${flash(o.flash)}
  <form class="form-card login-card" method="post" action="/admin/login" data-busy="Signing in…">
    <div class="field${o.error ? ' field-error' : ''}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password" autofocus>
      ${o.error ? `<p class="error-text" role="alert">${esc(o.error)}</p>` : ''}
    </div>
    <div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Sign in</button></div>
  </form>
</section>`;
  return layout({ title: `Sign in — ${SITE_NAME} admin`, description: 'Admin sign in.', noindex: true, noReferrer: true, body });
}

export function renderAdminDisabled(): string {
  const body = `<section class="container narrow page-simple">
  <p class="eyebrow">Error 503</p>
  <h1>Admin login is not set up.</h1>
  <p class="lead">Set <code>ADMIN_PASSWORD_HASH</code> in the server environment and restart. Generate the value with <code>pnpm hash-password</code> (or <code>node dist/src/hash-password.js</code> inside the container). A plain <code>ADMIN_PASSWORD</code> also works, but the hash is preferred.</p>
  <div class="actions"><a class="btn btn-primary" href="/">Back to ${SITE_NAME}</a></div>
</section>`;
  return layout({ title: `Admin unavailable — ${SITE_NAME}`, description: 'Admin login is not configured.', noindex: true, body });
}

// ---- dashboard -----------------------------------------------------------------

export interface DashboardOptions {
  csrf: string;
  tab: AdminTab;
  status: string;
  stage: string;
  q: string;
  flash?: string;
  counts: { newLeads: number; awaitingIntake: number; inProgress: number };
  revenueMonth: RevenueRow[];
  revenueAll: RevenueRow[];
  attention: {
    intakeOverdue: OrderRow[];
    leadsOverdue: LeadRow[];
    failedEmails: EmailRow[];
    awaitingReply: Array<OrderRow & { last_message_at: number }>;
  };
  orders: OrderRow[];
  leads: LeadRow[];
  emails: EmailRow[];
  totals: { orders: number; leads: number; waitlist: number; emails: number };
  smtp: { configured: boolean; host: string | undefined; port: number };
  notifyEmail: string;
  paymentsEnabled: boolean;
}

function revenueLines(rows: RevenueRow[]): string {
  if (rows.length === 0) return '<span class="stat-value">$0</span>';
  return rows.map((r) => `<span class="stat-value">${formatAmount(r.cents, r.currency)}</span><span class="stat-sub">${r.orders} order${r.orders === 1 ? '' : 's'}${rows.length > 1 ? ` · ${esc(r.currency)}` : ''}</span>`).join('');
}

function statTiles(o: DashboardOptions): string {
  const tile = (label: string, value: string, href?: string, tone?: string) =>
    `<${href ? `a href="${esc(href)}"` : 'div'} class="stat${tone ? ` stat-${tone}` : ''}"><span class="stat-label">${esc(label)}</span>${value}</${href ? 'a' : 'div'}>`;
  const num = (n: number) => `<span class="stat-value">${n}</span>`;
  return `<div class="stat-grid">
  ${tile('New leads awaiting reply', num(o.counts.newLeads), '/admin?tab=leads&status=new', o.counts.newLeads ? 'warn' : undefined)}
  ${tile('Paid, awaiting intake', num(o.counts.awaitingIntake), '/admin?tab=orders&stage=paid', o.counts.awaitingIntake ? 'warn' : undefined)}
  ${tile('Orders in progress', num(o.counts.inProgress), '/admin?tab=orders&stage=open')}
  ${tile('Revenue this month', revenueLines(o.revenueMonth))}
  ${tile('Revenue all time', revenueLines(o.revenueAll))}
</div>`;
}

function attentionList(o: DashboardOptions): string {
  const a = o.attention;
  const items: string[] = [
    ...a.awaitingReply.map(
      (x) => `<li><span class="status status-pending">client message</span><a class="inline" href="/admin/orders/${esc(x.id)}">${esc(x.id)}</a><span>${esc(x.email || 'no email')} wrote ${when(x.last_message_at)} and has no reply yet.</span></li>`,
    ),
    ...a.intakeOverdue.map(
      (x) => `<li><span class="status status-cancelled">no intake</span><a class="inline" href="/admin/orders/${esc(x.id)}">${esc(x.id)}</a><span>${esc(findTier(x.plan)?.name ?? x.plan)} paid ${when(x.paid_at ?? x.updated_at)}, still no intake after 24 hours.</span></li>`,
    ),
    ...a.leadsOverdue.map(
      (x) => `<li><span class="status status-cancelled">lead waiting</span><a class="inline" href="/admin/leads/${x.id}">${esc(x.name)}</a><span>${esc(x.email)} asked ${when(x.created_at)} and has not been contacted.</span></li>`,
    ),
    ...a.failedEmails.map(
      (x) => `<li><span class="status status-failed">email failed</span><a class="inline" href="/admin/emails/${x.id}">${esc(x.subject)}</a><span>to ${esc(x.to_addr)}: ${esc(x.last_error ?? 'unknown error')}</span></li>`,
    ),
  ];
  return `<div class="card attention">
  <h2 class="card-title">Needs attention${items.length ? ` <span class="count">${items.length}</span>` : ''}</h2>
  ${items.length ? `<ul class="attention-list">${items.join('')}</ul>` : '<p class="dim small">Nothing is waiting on you.</p>'}
</div>`;
}

function link(tab: AdminTab, params: Record<string, string>): string {
  const q = new URLSearchParams({ tab, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)) });
  return `/admin?${q.toString()}`;
}

function filterBar(o: DashboardOptions, statuses: readonly string[], extra: Array<[value: string, label: string]> = []): string {
  const chip = (label: string, href: string, active: boolean) => `<a class="filter${active ? ' is-active' : ''}" href="${esc(href)}"${active ? ' aria-current="true"' : ''}>${esc(label)}</a>`;
  return `<div class="filters">
  <div class="filter-chips">
    ${chip('All', link(o.tab, { q: o.q }), !o.status && !o.stage)}
    ${statuses.map((s) => chip(s, link(o.tab, { status: s, q: o.q }), o.status === s)).join('')}
    ${extra.map(([value, label]) => chip(label, link(o.tab, { stage: value, q: o.q }), o.stage === value)).join('')}
  </div>
  <form class="search" method="get" action="/admin" role="search">
    <input type="hidden" name="tab" value="${esc(o.tab)}">
    ${o.status ? `<input type="hidden" name="status" value="${esc(o.status)}">` : ''}
    ${o.stage ? `<input type="hidden" name="stage" value="${esc(o.stage)}">` : ''}
    <label class="sr-only" for="q">Search by email or id</label>
    <input id="q" type="search" name="q" value="${esc(o.q)}" placeholder="Search email or id">
    <button type="submit" class="btn btn-secondary btn-sm">Search</button>
  </form>
</div>`;
}

const stageBadge = (o: OrderRow) => (isOrderStage(o.stage) ? `<span class="status stage-${esc(o.stage)}">${esc(ADMIN_STAGE_LABELS[o.stage])}</span>` : '<span class="dim">&ndash;</span>');
const clientEmail = (email: string) => (email && !isPlaceholderEmail(email) ? esc(email) : '<span class="dim">none</span>');

function ordersTable(orders: OrderRow[]): string {
  if (orders.length === 0) return '<p class="empty">No orders match.</p>';
  return `<div class="table-wrap"><table class="table">
<thead><tr><th>Order</th><th>When</th><th>Payment</th><th>Stage</th><th>Plan</th><th>Amount</th><th>Email</th></tr></thead>
<tbody>${orders
    .map(
      (o) => `<tr>
<td class="mono"><a class="inline" href="/admin/orders/${esc(o.id)}">${esc(o.id)}</a></td>
<td class="mono">${when(o.created_at)}</td>
<td><span class="status status-${esc(o.status)}">${esc(o.status)}</span>${o.refunded_at ? ' <span class="status status-cancelled">refunded</span>' : ''}</td>
<td>${stageBadge(o)}</td>
<td>${esc(findTier(o.plan)?.name ?? o.plan)}</td>
<td class="mono">${formatAmount(o.amount_cents, o.currency)}</td>
<td>${clientEmail(o.email)}</td>
</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

const packageLabel = (platform: string) => PLATFORM_LABELS[platform as PlatformChoice] ?? platform;

function leadsTable(leads: LeadRow[], waitlist: boolean): string {
  if (leads.length === 0) return `<p class="empty">${waitlist ? 'Nobody on the waitlist matches.' : 'No leads match.'}</p>`;
  if (waitlist) {
    return `<div class="table-wrap"><table class="table">
<thead><tr><th>Email</th><th>When</th><th>Status</th></tr></thead>
<tbody>${leads.map((l) => `<tr><td><a class="inline" href="/admin/leads/${l.id}">${esc(l.email)}</a></td><td class="mono">${when(l.created_at)}</td><td><span class="status lead-${esc(l.status)}">${esc(l.status)}</span></td></tr>`).join('')}</tbody></table></div>`;
  }
  return `<div class="table-wrap"><table class="table">
<thead><tr><th>Name</th><th>When</th><th>Status</th><th>Email</th><th>Package</th><th>Message</th></tr></thead>
<tbody>${leads
    .map(
      (l) => `<tr>
<td><a class="inline" href="/admin/leads/${l.id}">${esc(l.name)}</a></td>
<td class="mono">${when(l.created_at)}</td>
<td><span class="status lead-${esc(l.status)}">${esc(l.status)}</span></td>
<td>${esc(l.email)}</td>
<td>${esc(packageLabel(l.platform))}</td>
<td class="cell-wrap">${esc(l.message.length > 160 ? `${l.message.slice(0, 160)}…` : l.message)}</td>
</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function emailsTable(emails: EmailRow[]): string {
  if (emails.length === 0) return '<p class="empty">No email recorded yet.</p>';
  return `<div class="table-wrap"><table class="table">
<thead><tr><th>Subject</th><th>When</th><th>Status</th><th>Kind</th><th>To</th><th>Tries</th><th>Detail</th></tr></thead>
<tbody>${emails
    .map(
      (e) => `<tr>
<td><a class="inline" href="/admin/emails/${e.id}">${esc(e.subject)}</a></td>
<td class="mono">${when(e.created_at)}</td>
<td><span class="status mail-${esc(e.status)}">${esc(e.status)}</span></td>
<td class="mono">${esc(e.kind)}</td>
<td>${esc(e.to_addr)}</td>
<td class="mono">${e.attempts}</td>
<td class="cell-wrap dim">${esc(e.last_error ?? (e.sent_at ? `sent ${when(e.sent_at)}` : ''))}</td>
</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

export function renderDashboard(o: DashboardOptions): string {
  const tabs: Array<[AdminTab, string, number]> = [
    ['orders', 'Orders', o.totals.orders],
    ['leads', 'Leads', o.totals.leads],
    ['waitlist', 'Waitlist', o.totals.waitlist],
    ['emails', 'Email log', o.totals.emails],
  ];
  const panel =
    o.tab === 'orders'
      ? `${filterBar(o, ORDER_STATUSES, [['paid', 'awaiting intake'], ['open', 'in progress'], ['live', 'live']])}${ordersTable(o.orders)}`
      : o.tab === 'leads'
        ? `${filterBar(o, LEAD_STATUSES)}${leadsTable(o.leads, false)}`
        : o.tab === 'waitlist'
          ? `${filterBar(o, [])}${leadsTable(o.leads, true)}`
          : `${filterBar(o, EMAIL_STATUSES)}${emailsTable(o.emails)}`;

  const body = `${statTiles(o)}
  ${attentionList(o)}
  <div class="card mail-card">
    <div class="mail-card-text">
      <h2 class="card-title">Outgoing mail</h2>
      <p class="small ${o.smtp.configured ? 'dim' : 'warn-text'}">${
        o.smtp.configured
          ? `SMTP is configured (${esc(o.smtp.host ?? '')}:${o.smtp.port}). Notifications go to ${esc(o.notifyEmail)}.`
          : 'SMTP is not configured: every message is recorded as skipped and nobody is emailed. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS.'
      }</p>
      <p class="small dim">Hosted checkout is ${o.paymentsEnabled ? 'on' : 'off'}.</p>
    </div>
    <form method="post" action="/admin/test-email" data-busy="Queuing…">${csrfField(o.csrf)}<button type="submit" class="btn btn-secondary btn-sm">Send test email</button></form>
  </div>
  <nav class="tabs" aria-label="Sections" id="list">
    ${tabs.map(([key, label, n]) => `<a class="tab${o.tab === key ? ' is-active' : ''}" href="/admin?tab=${key}#list"${o.tab === key ? ' aria-current="page"' : ''}>${esc(label)} <span class="count">${n}</span></a>`).join('')}
  </nav>
  ${panel}`;
  return shell({ title: 'Dashboard', eyebrow: 'Admin', heading: 'Dashboard', csrf: o.csrf, flash: o.flash, body });
}

// ---- order detail --------------------------------------------------------------

export interface AdminOrderOptions {
  csrf: string;
  order: OrderRow;
  events: OrderEventRow[];
  intake: IntakeAnswers | undefined;
  emails: EmailRow[];
  clientUrl: string;
  flash?: string;
}

export function renderAdminOrder(o: AdminOrderOptions): string {
  const { order } = o;
  const tier = findTier(order.plan);
  const paid = order.status === 'paid';
  const hasEmail = Boolean(order.email) && !isPlaceholderEmail(order.email);
  const action = (name: string) => `/admin/orders/${esc(order.id)}/${name}`;
  const stageOptions = ORDER_STAGES.filter((s) => s !== 'cancelled')
    .map((s) => `<option value="${s}"${order.stage === s ? ' selected' : ''}>${esc(ADMIN_STAGE_LABELS[s])}</option>`)
    .join('');

  const summary = `<dl class="order-meta">
    <div><dt>Plan</dt><dd>${esc(tier?.name ?? order.plan)}</dd></div>
    <div><dt>Amount</dt><dd>${formatAmount(order.amount_cents, order.currency)}</dd></div>
    <div><dt>Payment</dt><dd><span class="status status-${esc(order.status)}">${esc(order.status)}</span>${order.refunded_at ? ` <span class="status status-cancelled">refunded ${when(order.refunded_at)}</span>` : ''}</dd></div>
    <div><dt>Stage</dt><dd>${isOrderStage(order.stage) ? `<span class="status stage-${esc(order.stage)}">${esc(ADMIN_STAGE_LABELS[order.stage])}</span>` : '<span class="dim">not started</span>'}</dd></div>
    <div><dt>Provider reference</dt><dd>${order.flw_id ? `<code>${esc(order.flw_id)}</code>` : '<span class="dim">none</span>'}</dd></div>
    <div><dt>Client email</dt><dd>${clientEmail(order.email)}</dd></div>
    <div><dt>Created</dt><dd>${when(order.created_at)}</dd></div>
    <div><dt>Paid</dt><dd>${order.paid_at ? when(order.paid_at) : '<span class="dim">&ndash;</span>'}</dd></div>
  </dl>`;

  const intake = o.intake
    ? `<dl class="kv card">${intakeSummary(o.intake)
        .filter(([, v]) => v)
        .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${/^https?:\/\/\S+$/.test(value) ? `<a class="inline" href="${esc(value)}" rel="noopener noreferrer" target="_blank">${esc(value)}</a>` : escLines(value)}</dd></div>`)
        .join('')}</dl>
    <p class="small dim">Received ${when(order.intake_at)}.</p>`
    : `<p class="empty">${paid ? 'The client has not submitted the intake yet.' : 'No intake: the order is not paid.'}</p>`;

  const emailLog = o.emails.length
    ? `<ul class="mini-list">${o.emails.map((e) => `<li><span class="status mail-${esc(e.status)}">${esc(e.status)}</span><a class="inline" href="/admin/emails/${e.id}">${esc(e.subject)}</a><span class="dim small">${esc(e.to_addr)} · ${when(e.created_at)}</span></li>`).join('')}</ul>`
    : '<p class="dim small">No email recorded for this order.</p>';

  const actions = paid
    ? `<form class="card action" method="post" action="${action('stage')}" data-busy="Saving…">
      ${csrfField(o.csrf)}
      <h3>Set stage</h3>
      <div class="field"><label for="stage">Stage</label><select id="stage" name="stage">${stageOptions}</select></div>
      <div class="field"><label for="reason">Message to the client</label><textarea id="reason" name="reason" rows="3" maxlength="2000" placeholder="Required for &ldquo;Needs client&rdquo;: what exactly do they need to do?">${order.stage === 'needs_client' ? esc(order.needs_client_reason) : ''}</textarea><p class="hint">Shown on their page and included in the email.</p></div>
      <button type="submit" class="btn btn-primary btn-sm">Save stage and notify</button>
    </form>
    <form class="card action" method="post" action="${action('update')}" data-busy="Posting…">
      ${csrfField(o.csrf)}
      <h3>Post an update</h3>
      <div class="field"><label for="update-body">Visible to the client</label><textarea id="update-body" name="body" rows="4" maxlength="4000" required placeholder="What changed, what you need, or when to expect the next step"></textarea></div>
      <button type="submit" class="btn btn-primary btn-sm">Post and email the client</button>
    </form>
    <form class="card action action-internal" method="post" action="${action('note')}">
      ${csrfField(o.csrf)}
      <h3>Internal note</h3>
      <div class="field"><label for="note-body">Never shown or emailed to the client</label><textarea id="note-body" name="body" rows="3" maxlength="4000" required></textarea></div>
      <button type="submit" class="btn btn-secondary btn-sm">Add note</button>
    </form>`
    : '<div class="card action"><h3>Not paid</h3><p class="small dim">Stages, updates and the intake open once the payment verifies.</p></div>';

  const emailAction = hasEmail
    ? `<form class="card action" method="post" action="${action('resend-link')}" data-busy="Queuing…">
      ${csrfField(o.csrf)}
      <h3>Client link</h3>
      <p class="small dim">Emails the private order link to ${esc(order.email)}.</p>
      <button type="submit" class="btn btn-secondary btn-sm"${paid ? '' : ' disabled'}>Resend order link</button>
    </form>`
    : `<form class="card action" method="post" action="${action('email')}">
      ${csrfField(o.csrf)}
      <h3>Client email</h3>
      <div class="field"><label for="client-email">No usable address on this order</label><input id="client-email" name="email" type="email" maxlength="254" required placeholder="client@company.com"></div>
      <button type="submit" class="btn btn-secondary btn-sm">Save email</button>
    </form>`;

  const cancelAction =
    paid && order.stage !== 'cancelled'
      ? `<form class="card action action-danger" method="post" action="${action('cancel')}">
      ${csrfField(o.csrf)}
      <h3>Cancel order</h3>
      <div class="field"><label for="cancel-reason">Reason (shown to the client)</label><textarea id="cancel-reason" name="reason" rows="2" maxlength="1000"></textarea></div>
      <label class="check"><input type="checkbox" name="refunded" value="1"> Refunded outside this system (removes it from revenue)</label>
      <button type="submit" class="btn btn-secondary btn-sm">Mark cancelled</button>
    </form>`
      : '';

  const body = `${summary}
  <div class="link-row">
    <span class="share-label">Client page</span>
    <input type="text" readonly value="${esc(o.clientUrl)}" aria-label="Client page link" onfocus="this.select()">
    <button type="button" class="btn btn-secondary btn-sm" data-copy="${esc(o.clientUrl)}">Copy</button>
    <a class="btn btn-secondary btn-sm" href="${esc(o.clientUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
  </div>
  <div class="detail-grid">
    <div class="detail-main">
      <h2 class="admin-h2">Intake</h2>
      ${intake}
      <h2 class="admin-h2">Timeline</h2>
      ${renderTimeline(o.events, { admin: true })}
      <h2 class="admin-h2">Email</h2>
      ${emailLog}
    </div>
    <aside class="detail-side" aria-label="Actions">
      ${actions}
      ${emailAction}
      ${cancelAction}
    </aside>
  </div>`;
  return shell({ title: `Order ${order.id}`, eyebrow: 'Order', heading: order.id, csrf: o.csrf, back: { href: '/admin?tab=orders', label: 'Orders' }, flash: o.flash, body });
}

// ---- lead detail ---------------------------------------------------------------

export function renderAdminLead(o: { csrf: string; lead: LeadRow; publicUrl: string; flash?: string }): string {
  const { lead } = o;
  const waitlist = lead.platform === 'deepscan';
  const subject = waitlist ? 'StoreLint deep scan' : `Your StoreLint request (${packageLabel(lead.platform)})`;
  const mailto = `mailto:${lead.email.replace(/[?&#%\s]/g, encodeURIComponent)}?subject=${encodeURIComponent(subject)}`;
  const rows: Array<[string, string]> = [
    ['Name', esc(lead.name)],
    ['Email', `<a class="inline" href="${esc(mailto)}">${esc(lead.email)}</a>`],
    ['Package', esc(packageLabel(lead.platform))],
    ['Repository', lead.repo_url ? `<a class="inline" href="${esc(lead.repo_url)}" rel="noopener noreferrer" target="_blank">${esc(lead.repo_url)}</a>` : ''],
    ['Store links', escLines(lead.store_links)],
    ['Message', escLines(lead.message)],
    ['Received', when(lead.created_at)],
    ['IP', esc(lead.ip)],
  ];
  const body = `<div class="detail-grid">
    <div class="detail-main">
      <dl class="kv card">${rows.filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <div class="actions-row"><a class="btn btn-primary btn-sm" href="${esc(mailto)}">Reply by email</a></div>
      ${
        waitlist
          ? ''
          : `<h2 class="admin-h2">Pay links</h2>
      <p class="small dim">Send one of these when the scope is agreed. The link opens the pricing section with that package selected.</p>
      <ul class="mini-list pay-links">${TIERS.map((t) => {
        const url = `${o.publicUrl}/ship?plan=${t.key}#prices`;
        return `<li><span>${esc(t.name)} <span class="dim">${esc(t.price)}</span></span><code>${esc(url)}</code><button type="button" class="btn btn-secondary btn-sm" data-copy="${esc(url)}">Copy pay link</button></li>`;
      }).join('')}</ul>`
      }
    </div>
    <aside class="detail-side" aria-label="Actions">
      <form class="card action" method="post" action="/admin/leads/${lead.id}">
        ${csrfField(o.csrf)}
        <h3>Status and notes</h3>
        <div class="field"><label for="lead-status">Status</label><select id="lead-status" name="status">${LEAD_STATUSES.map((s) => `<option value="${s}"${lead.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="lead-notes">Internal notes</label><textarea id="lead-notes" name="notes" rows="6" maxlength="5000" placeholder="Never shown to the lead">${esc(lead.notes)}</textarea></div>
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        ${lead.updated_at ? `<p class="hint">Last saved ${when(lead.updated_at)}.</p>` : ''}
      </form>
    </aside>
  </div>`;
  return shell({
    title: `Lead ${lead.id}`,
    eyebrow: 'Lead',
    heading: waitlist ? lead.email : lead.name,
    csrf: o.csrf,
    back: waitlist ? { href: '/admin?tab=waitlist', label: 'Waitlist' } : { href: '/admin?tab=leads', label: 'Leads' },
    flash: o.flash,
    body,
  });
}

// ---- email detail --------------------------------------------------------------

export function renderAdminEmail(o: { csrf: string; email: EmailRow; flash?: string }): string {
  const e = o.email;
  const related = e.related_type === 'order' && e.related_id ? `/admin/orders/${esc(e.related_id)}` : e.related_type === 'lead' && e.related_id ? `/admin/leads/${esc(e.related_id)}` : '';
  const body = `<dl class="order-meta">
    <div><dt>Status</dt><dd><span class="status mail-${esc(e.status)}">${esc(e.status)}</span></dd></div>
    <div><dt>To</dt><dd>${esc(e.to_addr)}</dd></div>
    <div><dt>Reply-To</dt><dd>${e.reply_to ? esc(e.reply_to) : '<span class="dim">none</span>'}</dd></div>
    <div><dt>Kind</dt><dd><code>${esc(e.kind)}</code></dd></div>
    <div><dt>Queued</dt><dd>${when(e.created_at)}</dd></div>
    <div><dt>Sent</dt><dd>${e.sent_at ? when(e.sent_at) : '<span class="dim">&ndash;</span>'}</dd></div>
    <div><dt>Attempts</dt><dd>${e.attempts}</dd></div>
    ${related ? `<div><dt>Related</dt><dd><a class="inline" href="${related}">${esc(e.related_type)} ${esc(e.related_id)}</a></dd></div>` : ''}
  </dl>
  ${e.last_error ? `<p class="flash flash-error">${esc(e.last_error)}</p>` : ''}
  ${
    e.status === 'failed' || e.status === 'skipped'
      ? `<form class="actions-row" method="post" action="/admin/emails/${e.id}/retry">${csrfField(o.csrf)}<button type="submit" class="btn btn-secondary btn-sm">Queue again</button></form>`
      : ''
  }
  <h2 class="admin-h2">Plain-text body</h2>
  <pre class="mail-body">${esc(e.body_text)}</pre>`;
  return shell({ title: `Email ${e.id}`, eyebrow: 'Email', heading: e.subject, csrf: o.csrf, back: { href: '/admin?tab=emails', label: 'Email log' }, flash: o.flash, body });
}

