import type { Finding, Report, Severity } from '../types.js';
import { SEVERITIES } from '../types.js';
import { CLI_COMMAND, SITE_NAME, esc, layout } from './html.js';

export interface ReportViewOptions {
  id: string;
  report: Report;
  shareUrl: string;
  createdAt: number;
  expiresAt: number;
}

const SEVERITY_LABEL: Record<Severity, { title: string; blurb: string }> = {
  blocker: { title: 'Blockers', blurb: 'These fail upload or review outright. Fix them before submitting.' },
  warning: { title: 'Warnings', blurb: 'Likely to be flagged by policy checks or reviewers, or to break on current devices.' },
  info: { title: 'Info', blurb: 'Good to know before you fill in the store forms.' },
};

const PLATFORM_LABEL = { android: 'Android', ios: 'iOS', both: 'Both' } as const;
const FRAMEWORK_LABEL = { flutter: 'Flutter', 'react-native': 'React Native', expo: 'Expo', unknown: 'Unknown framework' } as const;

function scoreClass(score: number): string {
  if (score >= 80) return 'score-good';
  if (score >= 50) return 'score-mid';
  return 'score-bad';
}

function verdict(r: Report): string {
  if (r.summary.blocker > 0) return `${r.summary.blocker} blocker${r.summary.blocker === 1 ? '' : 's'} would get this build rejected.`;
  if (r.summary.warning > 0) return 'No blockers. Clear the warnings and you are in good shape.';
  return 'No blockers or warnings found. Ready to submit.';
}

function renderFinding(f: Finding): string {
  const where = f.file ? `<code class="where">${esc(f.file)}${f.line ? `:${f.line}` : ''}</code>` : '';
  return `<article class="finding sev-${esc(f.severity)}" id="${esc(f.id)}">
  <header class="finding-head">
    <span class="badge badge-platform">${esc(PLATFORM_LABEL[f.platform] ?? f.platform)}</span>
    <h3>${esc(f.title)}</h3>
  </header>
  ${f.detail ? `<p>${esc(f.detail)}</p>` : ''}
  ${where ? `<p class="muted small">${where}</p>` : ''}
  ${f.fix ? `<div class="fix"><strong>Fix:</strong> ${esc(f.fix)}</div>` : ''}
  <p class="small muted finding-meta"><code>${esc(f.id)}</code>${f.docs ? ` &middot; <a href="${esc(f.docs)}" rel="noopener noreferrer" target="_blank">Documentation</a>` : ''}</p>
</article>`;
}

function renderGroup(sev: Severity, findings: Finding[]): string {
  const meta = SEVERITY_LABEL[sev];
  if (findings.length === 0) {
    return `<section class="group group-${sev}">
  <h2>${meta.title} <span class="count">0</span></h2>
  <p class="muted">None found.</p>
</section>`;
  }
  return `<section class="group group-${sev}">
  <h2>${meta.title} <span class="count">${findings.length}</span></h2>
  <p class="muted">${meta.blurb}</p>
  ${findings.map(renderFinding).join('\n')}
</section>`;
}

export function renderReport(o: ReportViewOptions): string {
  const r = o.report;
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, r.findings.filter((f) => f.severity === s)])) as Record<
    Severity,
    Finding[]
  >;
  const scanned = new Date(r.scannedAt);
  const scannedLabel = Number.isNaN(scanned.getTime()) ? r.scannedAt : scanned.toUTCString();
  const expires = new Date(o.expiresAt).toUTCString();
  const title = `${r.project.name}: score ${r.summary.score}/100 — ${SITE_NAME} report`;

  const body = `
<section class="section report-head">
  <div class="container">
    <p class="eyebrow">${SITE_NAME} report &middot; ${esc(FRAMEWORK_LABEL[r.project.framework] ?? r.project.framework)}</p>
    <div class="report-top">
      <div>
        <h1>${esc(r.project.name)}</h1>
        <p class="lead">${esc(verdict(r))}</p>
        <p class="muted small">Scanned ${esc(scannedLabel)}. This link expires ${esc(expires)}.</p>
      </div>
      <div class="score ${scoreClass(r.summary.score)}" role="img" aria-label="Score ${r.summary.score} out of 100">
        <span class="score-num">${r.summary.score}</span>
        <span class="score-of">/ 100</span>
      </div>
    </div>
    <ul class="summary-chips">
      <li class="chip chip-blocker"><strong>${r.summary.blocker}</strong> blockers</li>
      <li class="chip chip-warning"><strong>${r.summary.warning}</strong> warnings</li>
      <li class="chip chip-info"><strong>${r.summary.info}</strong> info</li>
    </ul>
    <div class="share">
      <label for="share-url">Share this report</label>
      <div class="code-block">
        <input id="share-url" type="text" readonly value="${esc(o.shareUrl)}">
        <button type="button" class="btn btn-sm" data-copy="${esc(o.shareUrl)}">Copy link</button>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="container narrow findings">
    ${SEVERITIES.map((s) => renderGroup(s, bySeverity[s])).join('\n')}
  </div>
</section>

<section class="section cta">
  <div class="container narrow center">
    <h2>Want this fixed and shipped?</h2>
    <p class="lead">We fix every finding above, set up signing and store listings, and submit for review. 48-hour turnaround, from $149.</p>
    <a class="btn btn-primary btn-lg" href="/ship">Ship it for me</a>
    <p class="muted small">Or re-run locally any time: <code>${esc(CLI_COMMAND)}</code></p>
  </div>
</section>`;

  return layout({
    title,
    description: `${verdict(r)} ${r.summary.blocker} blockers, ${r.summary.warning} warnings, ${r.summary.info} info.`,
    canonical: o.shareUrl,
    noindex: true,
    body,
  });
}
