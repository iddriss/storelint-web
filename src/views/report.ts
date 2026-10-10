import type { Finding, Report, Severity } from '../types.js';
import { SEVERITIES } from '../types.js';
import { CLI_COMMAND, ICON, SITE_NAME, esc, layout } from './html.js';

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

const PLATFORM_LABEL = { android: 'android', ios: 'ios', both: 'android+ios' } as const;
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
  <div class="finding-head">
    <span class="finding-id">${esc(f.id)}</span>
    <span class="badge">${esc(PLATFORM_LABEL[f.platform] ?? f.platform)}</span>
  </div>
  <h3>${esc(f.title)}</h3>
  ${f.detail ? `<p class="detail">${esc(f.detail)}</p>` : ''}
  ${where}
  ${f.fix ? `<div class="fix"><span class="fix-label">Fix</span>${esc(f.fix)}</div>` : ''}
  ${f.docs ? `<p class="finding-foot"><a href="${esc(f.docs)}" rel="noopener noreferrer" target="_blank">Documentation</a></p>` : ''}
</article>`;
}

function renderGroup(sev: Severity, findings: Finding[]): string {
  const meta = SEVERITY_LABEL[sev];
  return `<section class="group group-${sev}">
  <div class="group-head"><h2>${meta.title}</h2><span class="count">${findings.length}</span></div>
  ${findings.length === 0 ? '<p class="group-empty">None found.</p>' : `<p class="group-blurb">${meta.blurb}</p>\n  ${findings.map(renderFinding).join('\n  ')}`}
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
  const score = Math.max(0, Math.min(100, r.summary.score));

  const body = `
<section class="report-head">
  <div class="container">
    <p class="eyebrow">${SITE_NAME} report &middot; ${esc(FRAMEWORK_LABEL[r.project.framework] ?? r.project.framework)}</p>
    <div class="report-top">
      <div class="report-info">
        <h1>${esc(r.project.name)}</h1>
        <p class="lead">${esc(verdict(r))}</p>
        <p class="report-meta">Scanned <span class="mono">${esc(scannedLabel)}</span>. Link expires <span class="mono">${esc(expires)}</span>.</p>
        <ul class="chips">
          <li class="chip chip-blocker"><strong>${r.summary.blocker}</strong> blocker${r.summary.blocker === 1 ? '' : 's'}</li>
          <li class="chip chip-warning"><strong>${r.summary.warning}</strong> warning${r.summary.warning === 1 ? '' : 's'}</li>
          <li class="chip chip-info"><strong>${r.summary.info}</strong> info</li>
        </ul>
      </div>
      <div class="score ${scoreClass(score)}" style="--pct:${score}" role="img" aria-label="Score ${score} out of 100">
        <div class="score-inner"><span class="score-num">${score}</span><span class="score-of">/ 100</span></div>
      </div>
    </div>
    <div class="share">
      <label class="share-label" for="share-url">Share</label>
      <input id="share-url" type="text" readonly value="${esc(o.shareUrl)}">
      <button type="button" class="btn btn-secondary btn-sm" data-copy="${esc(o.shareUrl)}">Copy link</button>
    </div>
  </div>
</section>

<section class="section findings">
  <div class="container mid">
    ${SEVERITIES.map((s) => renderGroup(s, bySeverity[s])).join('\n    ')}
  </div>
</section>

<section class="section cta">
  <div class="container">
    <div class="section-head center">
      <span class="eyebrow">Ship it for me</span>
      <h2>Want this fixed and shipped?</h2>
      <p class="lead">We fix every finding above, set up signing and store listings, and submit for review. 48-hour turnaround, from <span class="mono">$149</span>.</p>
    </div>
    <div class="cta-actions">
      <a class="btn btn-primary btn-lg" href="/ship">Ship it for me</a>
      <a class="text-link" href="/#checks">${ICON.terminal}See every check ${ICON.arrow}</a>
    </div>
    <p class="cta-foot">Re-run locally any time: <code>${esc(CLI_COMMAND)}</code></p>
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
