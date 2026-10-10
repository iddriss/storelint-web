import type { PayLinks } from '../config.js';
import type { LeadFormValues } from '../leads.js';
import { PLATFORMS, PLATFORM_LABELS } from '../leads.js';
import { SITE_NAME, SITE_URL, esc, layout } from './html.js';

export interface ShipViewOptions {
  payLinks: PayLinks;
  /** Pre-selected platform (from ?plan=). */
  plan?: string;
  values?: Partial<LeadFormValues>;
  errors?: Partial<Record<keyof LeadFormValues, string>>;
}

interface Tier {
  key: 'play' | 'ios' | 'both' | 'fix';
  name: string;
  price: string;
  blurb: string;
  featured?: boolean;
}

const TIERS: Tier[] = [
  { key: 'play', name: 'Google Play', price: '$149', blurb: 'Android release to production on Play, including the Data Safety and content-rating forms.' },
  { key: 'ios', name: 'App Store', price: '$199', blurb: 'iOS release through App Store Connect, including privacy manifest, usage strings and review notes.' },
  { key: 'both', name: 'Both stores', price: '$299', blurb: 'Android and iOS together. One handover, one invoice.', featured: true },
  { key: 'fix', name: 'Fix a rejection', price: '$99', blurb: 'Already rejected? Send the review message. We fix the cause and resubmit.' },
];

function tierButton(t: Tier, links: PayLinks): string {
  const pay = links[t.key];
  if (pay) {
    return `<a class="btn ${t.featured ? 'btn-primary' : 'btn-ghost'}" href="${esc(pay)}" rel="noopener">Pay ${esc(t.price)} &amp; start</a>`;
  }
  return `<a class="btn ${t.featured ? 'btn-primary' : 'btn-ghost'}" href="/ship?plan=${t.key}#lead">Request this</a>`;
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
  ${err ? `<p class="error-text" id="lead-${name}-error">${esc(err)}</p>` : hint ? `<p class="muted small">${hint}</p>` : ''}
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

  const body = `
<section class="hero hero-sm">
  <div class="container">
    <p class="eyebrow">Done-for-you release</p>
    <h1>We ship it for you.</h1>
    <p class="lead">Send us the repo. We fix every ${SITE_NAME} finding, set up signing, listings and compliance forms, and submit to the stores. 48-hour turnaround from the moment we have access, fixed price, no retainer.</p>
  </div>
</section>

<section class="section" id="prices">
  <div class="container">
    <h2>Pick a package</h2>
    <div class="grid-4 pricing">
      ${TIERS.map(
        (t) => `<div class="card price-card${t.featured ? ' price-featured' : ''}">
        <h3>${esc(t.name)}</h3>
        <p class="price">${esc(t.price)}</p>
        <p>${esc(t.blurb)}</p>
        ${tierButton(t, o.payLinks)}
      </div>`,
      ).join('\n')}
    </div>
    ${
      Object.values(o.payLinks).some(Boolean)
        ? '<p class="muted small">Prefer to talk first? Use the form below and we reply within one business day.</p>'
        : '<p class="muted small">Payment is collected after we confirm scope. Request a package below and we reply within one business day.</p>'
    }
  </div>
</section>

<section class="section section-alt" id="included">
  <div class="container">
    <h2>What&rsquo;s included</h2>
    <div class="grid-3">
      <div class="card">
        <h3>Fix every finding</h3>
        <ul class="check-list">
          <li>SDK targets, 16 KB page-size, Play Billing and Play Core updates</li>
          <li>Privacy manifest, usage descriptions, ATS and entitlements</li>
          <li>Release signing set up properly, keystore and secrets out of the repo</li>
          <li>Icons, launch screen, bundle ids and version numbers</li>
        </ul>
      </div>
      <div class="card">
        <h3>Store setup</h3>
        <ul class="check-list">
          <li>Play Console: Data Safety, content rating, target audience, testers</li>
          <li>App Store Connect: privacy nutrition labels, export compliance, review notes</li>
          <li>Screenshots and listing copy if you have the assets</li>
          <li>Submission, and we babysit the review</li>
        </ul>
      </div>
      <div class="card">
        <h3>48-hour turnaround</h3>
        <ul class="check-list">
          <li>Starts when we have repo and console access</li>
          <li>Every change lands as a reviewed pull request</li>
          <li>Written handover: what changed and why, how to release next time</li>
          <li>Rejection within 30 days of our submission? We fix it free.</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="section" id="lead">
  <div class="container narrow">
    <h2>Request a package</h2>
    <p class="lead">No payment now. Tell us about the app and we come back within one business day with a confirmed scope.</p>
    <form class="lead-form" method="post" action="/ship#lead" data-busy="Sending…" novalidate>
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
        'Optional. We will ask for read access after we confirm scope.',
      )}
      ${field(
        'message',
        'Anything else',
        `<textarea id="lead-message" name="message" rows="5" maxlength="5000" placeholder="Framework, deadline, the rejection message if you have one, link to a StoreLint report…">${esc(v.message)}</textarea>`,
        errors,
      )}
      <button type="submit" class="btn btn-primary btn-lg">Send request</button>
      <p class="muted small">We only use this to reply about your release. No newsletter.</p>
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

export function renderThanks(o: { name: string; platform: string }): string {
  const waitlist = o.platform === 'deepscan';
  const body = `<section class="container narrow section">
  <p class="eyebrow">${waitlist ? 'Deep scan' : 'Request received'}</p>
  <h1>${waitlist ? 'You are on the list.' : `Thanks${o.name && !o.name.startsWith('(') ? `, ${esc(o.name)}` : ''}.`}</h1>
  <p class="lead">${
    waitlist
      ? 'We will email you once binary deep scans are live. Until then, the free project scan catches the vast majority of rejections.'
      : 'We will reply within one business day with a confirmed scope and next steps. If you have a StoreLint report link, feel free to reply with it.'
  }</p>
  <p><a class="btn btn-primary" href="/">Back to ${SITE_NAME}</a> <a class="btn btn-ghost" href="/#scan">Run a scan</a></p>
</section>`;
  return layout({ title: `Thanks — ${SITE_NAME}`, description: 'Request received.', noindex: true, body });
}
