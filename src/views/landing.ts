import type { PayLinks } from '../config.js';
import { CLI_COMMAND, SITE_NAME, SITE_TAGLINE, SITE_URL, esc, layout } from './html.js';

export interface LandingOptions {
  payLinks: PayLinks;
  scannerAvailable: boolean;
}

const ANDROID_CHECKS = [
  'targetSdk / compileSdk below 35',
  '16 KB page-size support (AGP 8.5.1+, NDK r28+)',
  'minSdk below 21',
  'com.example application id',
  'Release build signed with the debug key',
  'Keystores and key.properties tracked by git',
  'Cleartext traffic allowed',
  'Components with intent-filters but no android:exported',
  'Legacy Play Core library',
  'AD_ID permission vs. ads SDK mismatch',
  'Dangerous permissions (for the Data Safety form)',
  'Missing versionCode / minify without ProGuard rules',
  'Play Billing library older than required',
];

const IOS_CHECKS = [
  'Deployment target below 13',
  'Missing PrivacyInfo.xcprivacy manifest',
  'Required-reason APIs not declared',
  'Camera, photo, location, mic, contacts, Bluetooth and Face ID usage strings missing for the plugins you use',
  'ITSAppUsesNonExemptEncryption not set',
  'App Transport Security disabled',
  'com.example / org.reactjs.native.example bundle id',
  'Project needs Xcode 26 / iOS 26 SDK for new submissions',
  'Push SDK present but no aps-environment entitlement',
  'No launch screen storyboard',
];

const CROSS_CHECKS = [
  'API keys and private keys in tracked source',
  '.env files tracked by git',
  'Placeholder config (YOUR_API_KEY, TODO, localhost)',
  'Incomplete adaptive icon / missing 1024px App Store icon',
  'Default app names (flutter_app, MyApp)',
  'pubspec / app.json version drifting from native versions',
  'Very old Flutter, React Native or Expo SDK',
  'Expo app.json missing bundleIdentifier / package',
];

function checkList(items: string[]): string {
  return `<ul class="check-list">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

export function renderLanding(o: LandingOptions): string {
  const shipHref = '/ship';
  const body = `
<section class="hero">
  <div class="container">
    <p class="eyebrow">For Flutter, React Native and Expo apps</p>
    <h1>Find out why the stores would reject your app<br class="br-wide"> before you submit.</h1>
    <p class="lead">${esc(SITE_NAME)} scans your project for everything that gets apps blocked or rejected on Google Play and the App Store in 2026: SDK targets, privacy manifests, missing usage strings, debug signing, leaked keys and more. Free, open source, runs in seconds.</p>
    <div class="hero-actions">
      <a class="btn btn-primary btn-lg" href="#scan">Scan a project</a>
      <a class="btn btn-ghost btn-lg" href="${shipHref}">Or let us ship it for you &rarr;</a>
    </div>
  </div>
</section>

<section class="section" id="run">
  <div class="container">
    <h2>Run it in three steps</h2>
    <ol class="steps">
      <li>
        <h3>1. Run the CLI in your project</h3>
        <div class="code-block">
          <code>${esc(CLI_COMMAND)}</code>
          <button type="button" class="btn btn-sm" data-copy="${esc(CLI_COMMAND)}">Copy</button>
        </div>
        <p class="muted">Needs Node 18+. Nothing leaves your machine. Add <code>--ci</code> to fail the build on blockers, <code>--json</code> for machine output.</p>
      </li>
      <li>
        <h3>2. Read the report</h3>
        <p>Findings are grouped into blockers, warnings and info, each with the file, the reason, and a concrete fix. The score is 100 minus 25 per blocker and 5 per warning.</p>
      </li>
      <li>
        <h3>3. Fix it, or hand it over</h3>
        <p>Most fixes take minutes with the instructions in the report. If you would rather not deal with store consoles at all, <a href="${shipHref}">we ship it for you</a> in 48 hours.</p>
      </li>
    </ol>
  </div>
</section>

<section class="section section-alt" id="scan">
  <div class="container narrow">
    <h2>No terminal handy? Upload a zip</h2>
    <p class="lead">Zip your project folder (node_modules, build and .git can be left out) and get a shareable report.</p>
    ${
      o.scannerAvailable
        ? ''
        : '<p class="notice">The scanner module is not installed on this server yet, so uploads currently return a placeholder report. The CLI above works today.</p>'
    }
    <form class="upload-form" method="post" action="/scan" enctype="multipart/form-data" data-busy="Scanning…">
      <label class="file-label" for="file">Project zip (up to 50 MB)</label>
      <input id="file" name="file" type="file" accept=".zip,application/zip,application/x-zip-compressed" required>
      <button type="submit" class="btn btn-primary">Scan it</button>
      <p class="muted small">The upload is extracted to a temporary folder, scanned, and deleted right away. Only the report is kept, for 7 days, under an unguessable link. Limit: 10 scans per hour per IP.</p>
    </form>
  </div>
</section>

<section class="section" id="checks">
  <div class="container">
    <h2>What it checks</h2>
    <p class="lead">Every check maps to a current Play Console or App Store Connect requirement and comes with a fix. Blockers are things that fail upload or review outright; warnings are things reviewers and policy bots flag.</p>
    <div class="grid-3">
      <div class="card"><h3>Android</h3>${checkList(ANDROID_CHECKS)}</div>
      <div class="card"><h3>iOS</h3>${checkList(IOS_CHECKS)}</div>
      <div class="card"><h3>Both platforms</h3>${checkList(CROSS_CHECKS)}</div>
    </div>
  </div>
</section>

<section class="section section-alt" id="pricing">
  <div class="container">
    <h2>Pricing</h2>
    <div class="grid-3 pricing">
      <div class="card price-card">
        <h3>Free</h3>
        <p class="price">$0</p>
        <p>The CLI and the web scan. Unlimited projects, no account.</p>
        <ul class="check-list">
          <li>Every check listed above</li>
          <li>JSON output for CI</li>
          <li>Shareable web reports</li>
        </ul>
        <a class="btn btn-ghost" href="#scan">Run a scan</a>
      </div>
      <div class="card price-card">
        <h3>Deep scan <span class="badge">coming soon</span></h3>
        <p class="price">$19 <span class="per">one-off</span></p>
        <p>Upload the built AAB or IPA for binary-level checks: 16 KB alignment, embedded SDK versions, signing, entitlements, privacy manifest merge.</p>
        <form class="inline-form" method="post" action="/ship" data-busy="Saving…">
          <input type="hidden" name="platform" value="deepscan">
          <input type="hidden" name="name" value="">
          <input type="hidden" name="message" value="Deep scan waitlist">
          <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
          <label class="sr-only" for="deepscan-email">Email</label>
          <input id="deepscan-email" type="email" name="email" placeholder="you@company.com" required>
          <button type="submit" class="btn btn-ghost">Notify me</button>
        </form>
      </div>
      <div class="card price-card price-featured">
        <h3>Ship it for me</h3>
        <p class="price">from $149</p>
        <p>We take your repo, fix every finding, and get the app live on the stores. 48-hour turnaround.</p>
        <ul class="check-list">
          <li>Google Play: $149</li>
          <li>App Store: $199</li>
          <li>Both stores: $299</li>
          <li>Fix a rejection: $99</li>
        </ul>
        <a class="btn btn-primary" href="${shipHref}">See what&rsquo;s included</a>
      </div>
    </div>
  </div>
</section>

<section class="section cta">
  <div class="container narrow center">
    <h2>Don&rsquo;t want to deal with store consoles?</h2>
    <p class="lead">Send us the repo. We fix the findings, set up signing and listings, and submit, with a written handover of everything we changed.</p>
    <a class="btn btn-primary btn-lg" href="${shipHref}">Ship it for me</a>
  </div>
</section>`;

  return layout({
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description:
      'Free scanner for Flutter, React Native and Expo projects that finds everything Google Play and the App Store will reject in 2026, with fixes. Or let us ship it for you.',
    canonical: SITE_URL + '/',
    body,
  });
}
