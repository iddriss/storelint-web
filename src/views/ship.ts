import type { PayLinks } from '../config.js';
import type { LeadFormValues } from '../leads.js';
import { PLATFORMS, PLATFORM_LABELS } from '../leads.js';
import { SITE_NAME, SITE_URL, esc, layout } from './html.js';
import { findOrderForm } from './order.js';

export interface ShipViewOptions {
  payLinks: PayLinks;
  /** When true (FLW_SECRET_KEY set), price cards post to /pay/:plan unless a PAY_LINK_* wins. */
  paymentsEnabled?: boolean;
  /** Pre-selected platform (from ?plan=). */
  plan?: string;
  values?: Partial<LeadFormValues>;
  errors?: Partial<Record<keyof LeadFormValues, string>>;
}

export type PlanKey = 'play' | 'ios' | 'both' | 'fix';

export interface Tier {
  key: PlanKey;
  name: string;
  price: string;
  /** Charged amount in minor units (USD cents). Keep in sync with `price`. */
  amountCents: number;
  blurb: string;
  featured?: boolean;
}

export const TIERS: Tier[] = [
  { key: 'play', name: 'Google Play', price: '$149', amountCents: 14900, blurb: 'Android release to production on Play, including the Data Safety and content-rating forms.' },
  { key: 'ios', name: 'App Store', price: '$199', amountCents: 19900, blurb: 'iOS release through App Store Connect, including privacy manifest, usage strings and review notes.' },
  { key: 'both', name: 'Both stores', price: '$299', amountCents: 29900, blurb: 'Android and iOS together. One handover, one invoice.', featured: true },
  { key: 'fix', name: 'Fix a rejection', price: '$99', amountCents: 9900, blurb: 'Already rejected? Send the review message. We fix the cause and resubmit.' },
];

export function findTier(plan: string | undefined): Tier | undefined {
  return TIERS.find((t) => t.key === plan);
}

export interface TierCardOptions {
  payLinks: PayLinks;
  paymentsEnabled?: boolean;
  /** Prefills the email field of the /pay forms (e.g. from the lead form). */
  email?: string;
}

/**
 * Precedence: PAY_LINK_* (external link) > hosted checkout form (FLW_SECRET_KEY set) > scroll to the lead form.
 */
export function tierButton(t: Tier, o: TierCardOptions): string {
  const cls = t.featured ? 'btn btn-primary' : 'btn btn-secondary';
  const pay = o.payLinks[t.key];
  if (pay) return `<a class="${cls}" href="${esc(pay)}" rel="noopener">Pay ${esc(t.price)} &amp; start</a>`;
  if (o.paymentsEnabled) {
    return `<form class="pay-form" method="post" action="/pay/${t.key}" data-busy="Opening checkout…">
      <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label class="sr-only" for="pay-email-${t.key}">Email for the receipt and intake checklist</label>
      <input id="pay-email-${t.key}" type="email" name="email" maxlength="254" autocomplete="email" placeholder="you@company.com" required value="${esc(o.email ?? '')}">
      <button type="submit" class="${cls}">Pay ${esc(t.price)} &amp; start</button>
    </form>`;
  }
  return `<a class="${cls}" href="/ship?plan=${t.key}#lead">Request this</a>`;
}

export function renderTierCards(o: TierCardOptions): string {
  return `<div class="grid grid-4">
${TIERS.map(
  (t) => `  <div class="card price-card${t.featured ? ' price-featured' : ''}">
    <h3>${esc(t.name)}</h3>
    <p class="price">${esc(t.price)}</p>
    <p>${esc(t.blurb)}</p>
    ${tierButton(t, o)}
  </div>`,
).join('\n')}
</div>`;
}

function field(
  name: keyof LeadFormValues,
  label: string,
  control: string,
  errors: ShipViewOptions['errors'],
  hint?: string,
): string {
  const err = errors?.[name];
  return `<div class="field${err ? ' field-error' : ''}">
  <label for="lead-${name}">${label}</label>
  ${control}
  ${err ? `<p class="error-text" id="lead-${name}-error">${esc(err)}</p>` : hint ? `<p class="hint">${hint}</p>` : ''}
</div>`;
}

export function renderShip(o: ShipViewOptions): string {
  const v: LeadFormValues = {
    name: o.values?.name ?? '',
    email: o.values?.email ?? '',
    platform: o.values?.platform ?? (o.plan && (PLATFORMS as readonly string[]).includes(o.plan) ? o.plan : 'both'),
    store_links: o.values?.store_links ?? '',
    repo_url: o.values?.repo_url ?? '',
    message: o.values?.message ?? '',
  };
  const errors = o.errors;
  const options = PLATFORMS.filter((p) => p !== 'deepscan')
    .map((p) => `<option value="${p}"${v.platform === p ? ' selected' : ''}>${esc(PLATFORM_LABELS[p])}</option>`)
    .join('');
  const anyPayLink = Object.values(o.payLinks).some(Boolean) || Boolean(o.paymentsEnabled);

  const body = `
<section class="hero hero-sm">
  <div class="hero-grid" aria-hidden="true"></div>
  <div class="container hero-inner">
    <p class="eyebrow" data-rise style="--d:90ms">Ship it for me</p>
    <h1 data-rise style="--d:180ms">We ship it for you.<span class="line2">Fixed price. 48-hour turnaround.</span></h1>
    <p class="hero-sub" data-rise style="--d:300ms">Send us the repo. We fix every ${esc(SITE_NAME)} finding, set up signing, listings and compliance forms, and submit to the stores. No retainer.</p>
    <div class="hero-actions" data-rise style="--d:400ms">
      <a class="btn btn-primary btn-lg" href="#lead">Request a package</a>
      <a class="text-link" href="#included">What&rsquo;s included <svg class="arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
    </div>
  </div>
</section>

<section class="section" id="prices">
  <div class="container">
    <div class="section-head tight">
      <span class="eyebrow">Packages</span>
      <h2>Pick a package.</h2>
      <p class="lead">${
        anyPayLink
          ? 'Pay to start right away (card, secured by Flutterwave), or use the form below if you want to talk first. We reply within one business day.'
          : 'Payment is collected after we confirm scope. Request a package and we reply within one business day.'
      }</p>
    </div>
    ${renderTierCards({ payLinks: o.payLinks, paymentsEnabled: o.paymentsEnabled, email: v.email })}
    <div class="card waitlist" id="find-order">
      <div class="waitlist-text">
        <h3>Already paid?</h3>
        <p>Your order page has the intake form and progress updates. Enter the email you used at checkout and we send the link again.</p>
      </div>
      ${findOrderForm({ compact: true })}
    </div>
  </div>
</section>

<section class="section" id="included">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">What&rsquo;s included</span>
      <h2>Everything between the repo and the store listing.</h2>
    </div>
    <div class="grid grid-3">
      <div class="card">
        <h3>Fix every finding</h3>
        <ul class="tick-list">
          <li>SDK targets, 16 KB page size, Play Billing and Play Core updates</li>
          <li>Privacy manifest, usage descriptions, ATS and entitlements</li>
          <li>Release signing set up properly, keystore and secrets out of the repo</li>
          <li>Icons, launch screen, bundle ids and version numbers</li>
        </ul>
      </div>
      <div class="card">
        <h3>Store setup</h3>
        <ul class="tick-list">
          <li>Play Console: Data Safety, content rating, target audience, testers</li>
          <li>App Store Connect: privacy labels, export compliance, review notes</li>
          <li>Screenshots and listing copy if you have the assets</li>
          <li>Submission, and we watch the review until it is through</li>
        </ul>
      </div>
      <div class="card">
        <h3>48-hour turnaround</h3>
        <ul class="tick-list">
          <li>Starts when we have repo and console access</li>
          <li>Every change lands as a reviewable pull request</li>
          <li>Written handover: what changed, why, and how to release next time</li>
          <li>Rejected within 30 days of our submission? We fix it free.</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="section" id="lead">
  <div class="container narrow">
    <div class="section-head tight">
      <span class="eyebrow">Request</span>
      <h2>Tell us about the app.</h2>
      <p class="lead">No payment now. We come back within one business day with a confirmed scope.</p>
    </div>
    <form class="form-card" method="post" action="/ship#lead" data-busy="Sending…" novalidate>
      <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      ${field('name', 'Your name', `<input id="lead-name" name="name" type="text" required maxlength="120" autocomplete="name" value="${esc(v.name)}">`, errors)}
      ${field('email', 'Email', `<input id="lead-email" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(v.email)}">`, errors)}
      ${field('platform', 'Package', `<select id="lead-platform" name="platform">${options}</select>`, errors)}
      ${field(
        'store_links',
        'Store links',
        `<textarea id="lead-store_links" name="store_links" rows="2" maxlength="2000" placeholder="Existing Play / App Store listings, if any">${esc(v.store_links)}</textarea>`,
        errors,
        'Optional. Leave empty for a first release.',
      )}
      ${field(
        'repo_url',
        'Repository URL',
        `<input id="lead-repo_url" name="repo_url" type="url" maxlength="500" placeholder="https://github.com/you/app" value="${esc(v.repo_url)}">`,
        errors,
        'Optional. We ask for read access after we confirm scope.',
      )}
      ${field(
        'message',
        'Anything else',
        `<textarea id="lead-message" name="message" rows="5" maxlength="5000" placeholder="Framework, deadline, the rejection message if you have one, a StoreLint report link…">${esc(v.message)}</textarea>`,
        errors,
      )}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">Send request</button>
        <span class="small dim">Only used to reply about your release. No newsletter.</span>
      </div>
    </form>
  </div>
</section>`;

  return layout({
    title: `Ship it for me — ${SITE_NAME}`,
    description:
      'Done-for-you Google Play and App Store release for Flutter, React Native and Expo apps. Play $149, App Store $199, both $299, fix a rejection $99. 48-hour turnaround.',
    canonical: SITE_URL + '/ship',
    body,
  });
}

export function renderThanks(o: { name: string; platform: string; emailEnabled?: boolean }): string {
  const waitlist = o.platform === 'deepscan';
  const body = `<section class="container narrow page-simple">
  <p class="eyebrow">${waitlist ? 'Deep scan' : 'Request received'}</p>
  <h1>${waitlist ? 'You are on the list.' : `Thanks${o.name && !o.name.startsWith('(') ? `, ${esc(o.name)}` : ''}.`}</h1>
  <p class="lead">${
    waitlist
      ? 'We will email you once binary deep scans are live. Until then, the free project scan catches most rejections.'
      : `${o.emailEnabled ? 'We just emailed you a confirmation. ' : ''}A developer replies within 24 hours with a confirmed scope and next steps. If you have a StoreLint report link, send it along when we reply.`
  }</p>
  <div class="actions"><a class="btn btn-primary" href="/">Back to ${SITE_NAME}</a> <a class="btn btn-secondary" href="/#scan">Run a scan</a></div>
</section>`;
  return layout({ title: `Thanks — ${SITE_NAME}`, description: 'Request received.', noindex: true, body });
}
