import type { PayLinks } from '../config.js';
import { CLI_COMMAND, CLI_VERSION, ICON, SITE_NAME, SITE_TAGLINE, SITE_URL, esc, layout } from './html.js';
import { renderTierCards } from './ship.js';

export interface LandingOptions {
  payLinks: PayLinks;
  paymentsEnabled?: boolean;
  scannerAvailable: boolean;
}

interface CheckGroup {
  title: string;
  blurb: string;
  checks: Array<[id: string, what: string]>;
  more: string[];
}

const CHECK_GROUPS: CheckGroup[] = [
  {
    title: 'Android',
    blurb: 'Play Console upload and policy checks.',
    checks: [
      ['android.target-sdk', 'targetSdk / compileSdk below 35'],
      ['android.page-size-16kb', 'AGP or NDK too old for 16 KB pages'],
      ['android.debug-signing', 'Release build signed with the debug key'],
      ['android.keystore-in-repo', 'Keystore or key.properties tracked by git'],
      ['android.cleartext', 'Cleartext traffic allowed'],
      ['android.play-billing', 'Play Billing library older than required'],
    ],
    more: ['android.min-sdk', 'android.application-id', 'android.exported', 'android.play-core-legacy', 'android.ads-id', 'android.permissions-dangerous', 'android.version-code', 'android.proguard'],
  },
  {
    title: 'iOS',
    blurb: 'App Store Connect and App Review checks.',
    checks: [
      ['ios.privacy-manifest', 'No PrivacyInfo.xcprivacy in the app target'],
      ['ios.required-reason-apis', 'Required-reason APIs not declared'],
      ['ios.usage-descriptions', 'Usage strings missing for the plugins you use'],
      ['ios.encryption-flag', 'ITSAppUsesNonExemptEncryption not set'],
      ['ios.ats', 'App Transport Security disabled'],
      ['ios.xcode-version', 'Project below the SDK new submissions require'],
    ],
    more: ['ios.deployment-target', 'ios.bundle-id', 'ios.push-entitlement', 'ios.launch-screen'],
  },
  {
    title: 'Everything else',
    blurb: 'Project-level checks for both stores.',
    checks: [
      ['app.secrets', 'API keys and private keys in tracked source'],
      ['app.dotenv-tracked', '.env files tracked by git'],
      ['app.placeholder-config', 'YOUR_API_KEY, TODO and localhost left in config'],
      ['app.icons', 'Incomplete adaptive icon or missing 1024px icon'],
      ['app.version-mismatch', 'pubspec / app.json version drifting from native'],
      ['app.flutter-version', 'Flutter, React Native or Expo SDK too old'],
    ],
    more: ['app.rn-version', 'app.expo', 'app.name'],
  },
];

function checkCard(g: CheckGroup): string {
  return `<div class="card">
  <h3>${esc(g.title)}</h3>
  <p>${esc(g.blurb)}</p>
  <ul class="id-list">${g.checks.map(([id, what]) => `<li><code>${esc(id)}</code><span>${esc(what)}</span></li>`).join('')}</ul>
  <p class="id-more">Also ${g.more.map(esc).join(', ')}</p>
</div>`;
}

/** Hero preview: what the CLI prints for a typical first scan of a Flutter app. */
function terminalPreview(): string {
  const line = (sev: 'blocker' | 'warn', id: string, platform: string, title: string, where: string, fix: string) =>
    `  <span class="t-${sev}">${sev === 'blocker' ? '✖' : '▲'}</span> <span class="t-id">${esc(id)}</span> <span class="t-dim">[${platform}]</span>
    <span class="t-fg">${esc(title)}</span>
    <span class="t-dim">${esc(where)}</span>
    <span class="t-dim">fix:</span> ${esc(fix)}
`;
  return `<div class="terminal" data-rise style="--d:520ms" aria-label="Example StoreLint output">
  <div class="terminal-bar" aria-hidden="true"><span class="terminal-dot"></span><span class="terminal-dot"></span><span class="terminal-dot"></span><span class="terminal-title">my_app — zsh</span></div>
<pre><span class="t-prompt">$</span> <span class="t-cmd">${esc(CLI_COMMAND)}</span>
<span class="t-fg">StoreLint</span> <span class="t-dim">v${esc(CLI_VERSION)}</span>  my_app <span class="t-dim">(flutter)</span>  <span class="t-dim">.</span>

  <span class="t-blocker">BLOCKERS (3)</span>
${line('blocker', 'android.target-sdk', 'android', 'targetSdk is 33; Google Play requires 35', 'android/app/build.gradle.kts:24', 'Set targetSdk = 36 and compileSdk = 36, then test on Android 15 and 16.')}${line('blocker', 'ios.privacy-manifest', 'ios', 'No PrivacyInfo.xcprivacy in the iOS app target', 'ios/Runner', 'Add ios/Runner/PrivacyInfo.xcprivacy with NSPrivacyAccessedAPITypes.')}${line('blocker', 'app.secrets', 'android+ios', 'Google API key committed in lib/config.dart (AIza…k3Q)', 'lib/config.dart:7', 'Move it to --dart-define or an ignored .env, then rotate the key.')}
  <span class="t-warn">WARNINGS (1)</span>
${line('warn', 'android.page-size-16kb', 'android', 'NDK r25 compiles native code with 4 KB page alignment (need r28+)', 'android/app/build.gradle.kts:12', 'Set ndkVersion = "28.0.13004108" and rebuild.')}
<span class="t-fg">Score</span> <span class="t-blocker">20/100</span>  <span class="t-dim">·</span>  3 blockers  <span class="t-dim">·</span>  1 warning  <span class="t-dim">·</span>  0 info
Want it fixed and shipped? <a class="t-link" href="/ship">${esc(SITE_URL)}/ship</a></pre>
</div>`;
}

export function renderLanding(o: LandingOptions): string {
  const body = `
<section class="hero">
  <div class="hero-grid" aria-hidden="true"></div>
  <div class="container">
    <div class="hero-inner">
      <p class="eyebrow" data-rise style="--d:90ms">Free scanner for Flutter, React Native and Expo</p>
      <h1 data-rise style="--d:180ms">Lint your app before the store does.<span class="line2">Catches 2026 Play and App Store rejections before you upload.</span></h1>
      <p class="hero-sub" data-rise style="--d:300ms">One command in your project. Every finding names the file, the reason and the fix. No account, nothing leaves your machine.</p>
      <div class="hero-actions" data-rise style="--d:400ms">
        <a class="btn btn-primary btn-lg" href="#run">Run it in 10 seconds</a>
        <a class="text-link" href="/ship">${ICON.package}Or let us ship it for you ${ICON.arrow}</a>
      </div>
    </div>
    ${terminalPreview()}
  </div>
</section>

<section class="section" id="run">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">CLI</span>
      <h2>Run it in 10 seconds.</h2>
      <p class="lead">Needs Node 18 or newer. Works on any Flutter, React Native or Expo checkout.</p>
    </div>
    <div class="grid grid-3">
      <div class="card">
        <span class="card-num">01</span>
        <h3>Run it in your project</h3>
        <div class="cmd"><code>${esc(CLI_COMMAND)}</code><button type="button" class="btn btn-secondary btn-sm" data-copy="${esc(CLI_COMMAND)}">Copy</button></div>
        <p>Add <code>--ci</code> to fail the build on blockers, <code>--json</code> for machine output.</p>
      </div>
      <div class="card">
        <span class="card-num">02</span>
        <h3>Read the findings</h3>
        <p>Grouped into blockers, warnings and info. Each one names the file and line, the store rule behind it, and the fix. Score is 100 minus 25 per blocker and 5 per warning.</p>
      </div>
      <div class="card">
        <span class="card-num">03</span>
        <h3>Fix it, or hand it over</h3>
        <p>Most fixes take minutes with the instructions in the report. If you would rather not touch the store consoles, <a class="inline" href="/ship">we ship it for you</a> in 48 hours.</p>
      </div>
    </div>
  </div>
</section>

<section class="section" id="scan">
  <div class="container narrow">
    <div class="section-head tight">
      <span class="eyebrow">Web scan</span>
      <h2>No terminal handy? Upload a zip.</h2>
      <p class="lead">Zip the project folder (node_modules, build output and .git can stay out) and get a shareable report.</p>
    </div>
    ${
      o.scannerAvailable
        ? ''
        : '<p class="notice">The scanner module is not installed on this server yet, so uploads currently return a placeholder report. The CLI works today.</p>'
    }
    <form class="form-card" method="post" action="/scan" enctype="multipart/form-data" data-busy="Scanning…">
      <div class="dropzone">
        ${ICON.upload}
        <label class="dropzone-label" for="file">Drop a project .zip here, or browse</label>
        <span class="dropzone-hint">Up to 50 MB</span>
        <span class="dropzone-file" aria-live="polite"></span>
        <input id="file" name="file" type="file" accept=".zip,application/zip,application/x-zip-compressed" required>
      </div>
      <div class="upload-actions">
        <button type="submit" class="btn btn-primary">Scan it</button>
        <span class="small dim">Extracted to a temp folder, scanned, deleted. The report stays 7 days under an unguessable link. 10 scans per hour per IP.</span>
      </div>
    </form>
  </div>
</section>

<section class="section" id="checks">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">What it checks</span>
      <h2>Every check maps to a current store rule.</h2>
      <p class="lead">Blockers fail upload or review outright. Warnings are what policy bots and reviewers flag. Each comes with a fix.</p>
    </div>
    <div class="grid grid-3">
      ${CHECK_GROUPS.map(checkCard).join('\n      ')}
    </div>
  </div>
</section>

<section class="section" id="pricing">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">Ship it for me</span>
      <h2>Need it shipped?</h2>
      <p class="lead">The scanner is free. If you want the findings fixed and the app live on the stores, we do it for a fixed price with a 48-hour turnaround.</p>
    </div>
    ${renderTierCards({ payLinks: o.payLinks, paymentsEnabled: o.paymentsEnabled })}
    <div class="card waitlist">
      <div class="waitlist-text">
        <h3>Deep scan <span class="badge">coming soon</span></h3>
        <p>Upload the built AAB or IPA for binary-level checks: 16 KB alignment, embedded SDK versions, signing, entitlements. Leave an email to hear when it is live.</p>
      </div>
      <form class="inline-form" method="post" action="/ship" data-busy="Saving…">
        <input type="hidden" name="platform" value="deepscan">
        <input type="hidden" name="name" value="">
        <input type="hidden" name="message" value="Deep scan waitlist">
        <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <label class="sr-only" for="deepscan-email">Email</label>
        <input id="deepscan-email" type="email" name="email" placeholder="you@company.com" required>
        <button type="submit" class="btn btn-secondary">Notify me</button>
      </form>
    </div>
  </div>
</section>

<section class="section cta">
  <div class="container">
    <div class="section-head center">
      <span class="eyebrow">Done for you</span>
      <h2>Don&rsquo;t want to deal with store consoles?</h2>
      <p class="lead">Send us the repo. We fix the findings, set up signing and listings, and submit, with a written handover of everything we changed.</p>
    </div>
    <div class="cta-actions">
      <a class="btn btn-primary btn-lg" href="/ship">Ship it for me</a>
      <a class="text-link" href="#scan">${ICON.terminal}Run a free scan first ${ICON.arrow}</a>
    </div>
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
