import { isPlaceholderEmail } from '../addresses.js';
import type { OrderEventRow, OrderRow } from '../db.js';
import type { IntakeAnswers, IntakeErrors, IntakeField, IntakeFormValues } from '../intake-form.js';
import { ACCOUNT_STATES, ACCOUNT_STATE_LABELS, CODE_SHARES, CODE_SHARE_LABELS, FRAMEWORKS, FRAMEWORK_LABELS, intakeSummary } from '../intake-form.js';
import type { OrderStage, PipelineStage } from '../stages.js';
import { PIPELINE, STAGE_HEADLINES, STAGE_LABELS, isOrderStage, isPipelineStage, nextSteps } from '../stages.js';
import { SITE_NAME, esc, escLines, layout, when } from './html.js';
import { formatAmount, renderChecklist } from './pay.js';
import type { Tier } from './ship.js';

export const MESSAGE_MAX = 4000;

/** Intake stays editable until the build is submitted; a blocked order is always editable. */
export function intakeEditable(order: Pick<OrderRow, 'status' | 'stage'>): boolean {
  return order.status === 'paid' && (order.stage === 'paid' || order.stage === 'intake_received' || order.stage === 'in_progress' || order.stage === 'needs_client');
}

export interface OrderPageOptions {
  order: OrderRow;
  tier: Tier | undefined;
  /** Client-visible events only, oldest first. */
  events: OrderEventRow[];
  intake: IntakeAnswers | undefined;
  /** Values to show in the form (stored answers, defaults, or a rejected submission). */
  intakeValues: IntakeFormValues;
  intakeErrors?: IntakeErrors;
  messageDraft?: string;
  messageError?: string;
  /** `intake` or `message` after a successful post. */
  done?: string;
  /** Address the client invites to the repo and the store consoles. */
  team: string;
}

const PAYMENT_LABELS: Record<string, string> = { paid: 'Paid', pending: 'Pending', failed: 'Not completed', cancelled: 'Cancelled' };

/** Which pipeline step to highlight: the stage itself, or where the order stood when it got blocked or cancelled. */
function stepperPosition(order: OrderRow): PipelineStage {
  if (isPipelineStage(order.stage)) return order.stage;
  if (isPipelineStage(order.stage_prev)) return order.stage_prev;
  return order.intake_json ? 'intake_received' : 'paid';
}

function stepper(order: OrderRow): string {
  const current = stepperPosition(order);
  const at = PIPELINE.indexOf(current);
  const blocked = order.stage === 'needs_client';
  const cancelled = order.stage === 'cancelled';
  const finished = order.stage === 'live';
  return `<ol class="stepper${blocked ? ' stepper-blocked' : ''}${cancelled ? ' stepper-off' : ''}" aria-label="Progress">
${PIPELINE.map((s, i) => {
  const state = i < at || (finished && i === at) ? 'done' : i === at ? 'current' : 'todo';
  return `  <li class="step is-${state}"${state === 'current' ? ' aria-current="step"' : ''}><span class="step-dot" aria-hidden="true">${state === 'done' ? '✓' : i + 1}</span><span class="step-label">${esc(STAGE_LABELS[s])}</span></li>`;
}).join('\n')}
</ol>`;
}

const ACTOR_LABELS: Record<string, string> = { admin: `${SITE_NAME} team`, client: 'You', system: SITE_NAME };

export function renderTimeline(events: OrderEventRow[], o: { admin?: boolean } = {}): string {
  if (events.length === 0) return '<p class="dim small">Nothing here yet.</p>';
  return `<ol class="timeline">
${[...events]
  .reverse()
  .map((e) => {
    const who = o.admin ? (e.actor === 'client' ? 'Client' : e.actor === 'admin' ? 'Team' : 'System') : (ACTOR_LABELS[e.actor] ?? SITE_NAME);
    return `  <li class="event event-${esc(e.actor)}${e.visibility === 'internal' ? ' event-internal' : ''}">
    <div class="event-meta"><span class="event-who">${esc(who)}</span>${o.admin ? `<span class="badge">${esc(e.type)}</span>${e.visibility === 'internal' ? '<span class="badge badge-internal">internal</span>' : ''}` : ''}<time datetime="${new Date(e.created_at).toISOString()}">${when(e.created_at)}</time></div>
    <div class="event-body">${escLines(e.body)}</div>
  </li>`;
  })
  .join('\n')}
</ol>`;
}

function fieldWrap(name: IntakeField, label: string, control: string, errors: IntakeErrors | undefined, hint?: string): string {
  const err = errors?.[name];
  return `<div class="field${err ? ' field-error' : ''}">
  <label for="intake-${name}">${label}</label>
  ${control}
  ${err ? `<p class="error-text" id="intake-${name}-error">${esc(err)}</p>` : hint ? `<p class="hint">${hint}</p>` : ''}
</div>`;
}

function options<T extends string>(list: readonly T[], labels: Record<T, string>, selected: string, placeholder?: string): string {
  return `${placeholder ? `<option value=""${selected ? '' : ' selected'} disabled>${esc(placeholder)}</option>` : ''}${list
    .map((v) => `<option value="${esc(v)}"${selected === v ? ' selected' : ''}>${esc(labels[v])}</option>`)
    .join('')}`;
}

function secretNotice(team: string): string {
  return `<p class="notice notice-secure"><strong>No passwords, API keys or store logins here.</strong> Give us access by inviting <a class="inline" href="mailto:${esc(team)}">${esc(team)}</a> to your repository and to Play Console / App Store Connect. Anything that looks like a secret is rejected so it never gets stored.</p>`;
}

function intakeForm(o: OrderPageOptions, base: string): string {
  const v = o.intakeValues;
  const e = o.intakeErrors;
  const platformErr = e?.platforms;
  return `<form class="form-card" method="post" action="${base}/intake#intake" data-busy="Saving…" novalidate>
  ${fieldWrap('app_name', 'App name', `<input id="intake-app_name" name="app_name" type="text" required maxlength="120" value="${esc(v.app_name)}">`, e)}
  <div class="field-row">
    ${fieldWrap('framework', 'Framework', `<select id="intake-framework" name="framework" required>${options(FRAMEWORKS, FRAMEWORK_LABELS, v.framework, 'Choose…')}</select>`, e)}
    <fieldset class="field${platformErr ? ' field-error' : ''}">
      <legend>Platforms</legend>
      <div class="checks">
        <label class="check"><input type="checkbox" name="platform_android" value="1"${v.platform_android ? ' checked' : ''}> Android</label>
        <label class="check"><input type="checkbox" name="platform_ios" value="1"${v.platform_ios ? ' checked' : ''}> iOS</label>
      </div>
      ${platformErr ? `<p class="error-text">${esc(platformErr)}</p>` : ''}
    </fieldset>
  </div>
  <div class="field-row">
    ${fieldWrap('code_share', 'How will you share the code?', `<select id="intake-code_share" name="code_share">${options(CODE_SHARES, CODE_SHARE_LABELS, v.code_share)}</select>`, e)}
    ${fieldWrap(
      'repo_url',
      'Repository or upload link',
      `<input id="intake-repo_url" name="repo_url" type="url" maxlength="500" placeholder="https://github.com/you/app" value="${esc(v.repo_url)}">`,
      e,
      `Then invite ${esc(o.team)} to it.`,
    )}
  </div>
  ${fieldWrap(
    'store_urls',
    'Existing store listings',
    `<textarea id="intake-store_urls" name="store_urls" rows="2" maxlength="2000" placeholder="Play / App Store links, one per line">${esc(v.store_urls)}</textarea>`,
    e,
    'Optional. Leave empty for a first release.',
  )}
  <div class="field-row">
    ${fieldWrap('play_account', 'Google Play Console account', `<select id="intake-play_account" name="play_account">${options(ACCOUNT_STATES, ACCOUNT_STATE_LABELS, v.play_account)}</select>`, e)}
    ${fieldWrap('apple_account', 'Apple Developer account', `<select id="intake-apple_account" name="apple_account">${options(ACCOUNT_STATES, ACCOUNT_STATE_LABELS, v.apple_account)}</select>`, e)}
  </div>
  ${fieldWrap('target_date', 'Target date', `<input id="intake-target_date" name="target_date" type="date" value="${esc(v.target_date)}">`, e, 'Optional. When do you need the app submitted?')}
  ${fieldWrap(
    'notes',
    'Anything else',
    `<textarea id="intake-notes" name="notes" rows="5" maxlength="5000" placeholder="SDK version, release track, the rejection message, who answers reviewer questions…">${esc(v.notes)}</textarea>`,
    e,
  )}
  <div class="form-actions">
    <button type="submit" class="btn btn-primary btn-lg">${o.intake ? 'Update intake' : 'Send intake'}</button>
    <span class="small dim">You can edit this until the build is submitted.</span>
  </div>
</form>`;
}

function intakeReadOnly(intake: IntakeAnswers): string {
  return `<dl class="kv card">${intakeSummary(intake)
    .filter(([, value]) => value)
    .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${escLines(value)}</dd></div>`)
    .join('')}</dl>`;
}

export function renderOrderPage(o: OrderPageOptions): string {
  const { order, tier } = o;
  const base = `/o/${esc(order.id)}/${esc(order.access_token)}`;
  const paid = order.status === 'paid';
  const stage: OrderStage | undefined = paid && isOrderStage(order.stage) ? order.stage : undefined;
  const editable = intakeEditable(order);
  const headline = stage ? STAGE_HEADLINES[stage] : order.status === 'pending' ? 'Payment still pending.' : 'This order has not been paid.';
  const email = order.email && !isPlaceholderEmail(order.email) ? order.email : '';

  // Each confirmation renders inside the section the browser lands on after the redirect.
  const intakeFlash = o.done === 'intake' ? '<p class="flash flash-ok" role="status">Intake saved. The team has been told and checks access next.</p>' : '';
  const messageFlash = o.done === 'message' ? '<p class="flash flash-ok" role="status">Message sent to the team.</p>' : '';

  const summary = `<dl class="order-meta">
    <div><dt>Package</dt><dd>${esc(tier?.name ?? order.plan)}</dd></div>
    <div><dt>Amount</dt><dd>${formatAmount(order.amount_cents, order.currency)}</dd></div>
    <div><dt>Payment</dt><dd><span class="status status-${esc(order.status)}">${esc(PAYMENT_LABELS[order.status] ?? order.status)}</span>${order.refunded_at ? ' <span class="status status-cancelled">Refunded</span>' : ''}</dd></div>
    <div class="wide"><dt>Order</dt><dd><code>${esc(order.id)}</code></dd></div>
    ${email ? `<div class="wide"><dt>Email</dt><dd>${esc(email)}</dd></div>` : ''}
  </dl>`;

  if (!stage) {
    const body = `<section class="container narrow page-order">
  <p class="eyebrow">Your order</p>
  <h1>${esc(headline)}</h1>
  <p class="lead">${
    order.status === 'pending'
      ? 'The payment provider has not confirmed this payment yet. This page updates on its own once the confirmation arrives; refresh in a minute.'
      : 'Nothing was charged for this order and no work has started.'
  }</p>
  ${summary}
  <div class="actions"><a class="btn btn-primary" href="/ship?plan=${esc(order.plan)}#prices">Back to packages</a></div>
</section>`;
    return layout({ title: `Your order — ${SITE_NAME}`, description: 'Order status.', noindex: true, noReferrer: true, body });
  }

  const steps = nextSteps(stage, { plan: order.plan, team: o.team });
  const banner =
    stage === 'needs_client'
      ? `<div class="banner banner-warn" role="alert"><p class="banner-title">We need something from you</p><p>${escLines(order.needs_client_reason || 'Check the latest update below.')}</p></div>`
      : stage === 'cancelled'
        ? `<div class="banner banner-off"><p class="banner-title">Order cancelled</p><p>${order.refunded_at ? 'A refund was issued outside this page. It can take a few days to reach your account.' : 'No further work happens on this order.'}</p></div>`
        : '';

  const intakeSection = editable
    ? `<div class="section-head tight">
      <span class="eyebrow">Intake</span>
      <h2>${o.intake ? 'Your intake' : 'Tell us about the app.'}</h2>
      <p class="lead">${o.intake ? `Received ${when(order.intake_at)}. Change anything that is out of date.` : 'Five minutes. This is what we need to start.'}</p>
    </div>
    ${intakeFlash}
    ${secretNotice(o.team)}
    ${o.intakeErrors ? '<p class="flash flash-error" role="alert">Some fields need another look. Nothing was saved yet.</p>' : ''}
    ${intakeForm(o, base)}`
    : `<div class="section-head tight">
      <span class="eyebrow">Intake</span>
      <h2>Your intake</h2>
      <p class="lead">${o.intake ? 'Locked now that the build is submitted. Send a message if something changed.' : 'No intake was submitted for this order.'}</p>
    </div>
    ${o.intake ? intakeReadOnly(o.intake) : ''}`;

  const intakeBlock = `<section class="section section-tight" id="intake">
  <div class="container narrow">
    ${intakeSection}
    <details class="checklist-details">
      <summary>Full intake checklist</summary>
      <p class="small dim">Everything a release needs, for reference. Items marked (Play) or (Apple) apply to that store only. Config values and demo logins travel through a password-manager share, never through this page.</p>
      <div class="grid">${renderChecklist()}</div>
    </details>
  </div>
</section>`;

  const updatesBlock = `<section class="section section-tight" id="updates">
  <div class="container narrow">
    <div class="section-head tight">
      <span class="eyebrow">Updates</span>
      <h2>Timeline</h2>
    </div>
    ${messageFlash}
    ${renderTimeline(o.events)}
  </div>
</section>`;

  // Until the intake is in, it is the one thing the client has to do, so it comes first. After that, updates lead.
  const intakeFirst = editable && !o.intake;

  const body = `<section class="container narrow page-order">
  <p class="eyebrow">Your order</p>
  <h1>${esc(headline)}</h1>
  ${banner}
  ${summary}
  ${stepper(order)}
  <div class="card next-steps">
    <h2 class="card-title">What happens next</h2>
    <ul class="tick-list">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
  </div>
</section>

${intakeFirst ? `${intakeBlock}\n\n${updatesBlock}` : `${updatesBlock}\n\n${intakeBlock}`}

<section class="section section-tight" id="messages">
  <div class="container narrow">
    <div class="section-head tight">
      <span class="eyebrow">Message</span>
      <h2>Send us a message.</h2>
      <p class="lead">It goes straight to the developers working on your release and shows up in the timeline.</p>
    </div>
    <form class="form-card" method="post" action="${base}/message#messages" data-busy="Sending…">
      <div class="field${o.messageError ? ' field-error' : ''}">
        <label for="message">Your message</label>
        <textarea id="message" name="message" rows="4" maxlength="${MESSAGE_MAX}" required placeholder="A question, a change, or what you just did on your side">${esc(o.messageDraft ?? '')}</textarea>
        ${o.messageError ? `<p class="error-text" role="alert">${esc(o.messageError)}</p>` : '<p class="hint">No passwords or keys, please.</p>'}
      </div>
      <div class="form-actions"><button type="submit" class="btn btn-primary">Send message</button></div>
    </form>
    <p class="section-foot">Bookmark this page: it is your private link, no account needed. Lost it? <a class="inline" href="/orders/find">Get it emailed again</a>.</p>
  </div>
</section>`;

  return layout({ title: `Your order — ${SITE_NAME}`, description: 'Order status, intake and updates.', noindex: true, noReferrer: true, body });
}

// ---- find my order -------------------------------------------------------------

export function findOrderForm(o: { value?: string; error?: string; compact?: boolean } = {}): string {
  return `<form class="${o.compact ? 'inline-form find-form' : 'form-card'}" method="post" action="/orders/find" data-busy="Sending…">
  <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
  ${
    o.compact
      ? `<label class="sr-only" for="find-email">Email used at checkout</label>
  <input id="find-email" type="email" name="email" maxlength="254" autocomplete="email" placeholder="you@company.com" required>
  <button type="submit" class="btn btn-secondary">Email my link</button>`
      : `<div class="field${o.error ? ' field-error' : ''}">
    <label for="find-email">Email used at checkout</label>
    <input id="find-email" type="email" name="email" maxlength="254" autocomplete="email" placeholder="you@company.com" required value="${esc(o.value ?? '')}">
    ${o.error ? `<p class="error-text" role="alert">${esc(o.error)}</p>` : '<p class="hint">We email the private link for every paid order under that address.</p>'}
  </div>
  <div class="form-actions"><button type="submit" class="btn btn-primary">Email my order link</button></div>`
  }
</form>`;
}

export function renderFindOrder(o: { value?: string; error?: string; emailEnabled: boolean; team: string }): string {
  const body = `<section class="container narrow page-simple">
  <p class="eyebrow">Find my order</p>
  <h1>Lost your order link?</h1>
  <p class="lead">${
    o.emailEnabled
      ? 'Enter the email you used at checkout and we send the link again. Order pages have no password; the link is the key.'
      : `Order links cannot be emailed from this server right now. Write to ${esc(o.team)} from the address you paid with, quoting your order number, and we will send it.`
  }</p>
  ${o.emailEnabled ? `<div class="find-wrap">${findOrderForm({ value: o.value, error: o.error })}</div>` : `<div class="actions"><a class="btn btn-primary" href="mailto:${esc(o.team)}?subject=${encodeURIComponent('My StoreLint order link')}">Email ${esc(o.team)}</a></div>`}
</section>`;
  return layout({ title: `Find my order — ${SITE_NAME}`, description: 'Get your order link emailed again.', noindex: true, body });
}

/** Identical for every address, whether or not it has orders. */
export function renderFindOrderSent(): string {
  const body = `<section class="container narrow page-simple">
  <p class="eyebrow">Find my order</p>
  <h1>Check your inbox.</h1>
  <p class="lead">If we have orders for that address, we just emailed the link(s). It can take a minute or two; look in spam as well.</p>
  <div class="actions"><a class="btn btn-primary" href="/">Back to ${SITE_NAME}</a> <a class="btn btn-secondary" href="/orders/find">Try another address</a></div>
</section>`;
  return layout({ title: `Check your inbox — ${SITE_NAME}`, description: 'Order link requested.', noindex: true, body });
}
