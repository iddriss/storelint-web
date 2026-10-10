export const SITE_NAME = 'StoreLint';
export const SITE_TAGLINE = 'lint your app before the store does';
export const SITE_URL = 'https://storelint.embracetech.org';
export const CLI_COMMAND = 'npx @iraaj/storelint';
export const REPO_URL = 'https://github.com/iddriss/storelint';
export const NPM_URL = 'https://www.npmjs.com/package/@iraaj/storelint';
export const CLI_VERSION = '0.1.0';
/** Bump when style.css changes so clients past the 1h static cache pick it up. */
export const STYLE_VERSION = '5';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Small inline icons (stroke = currentColor), no external assets. */
export const ICON = {
  mark: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5" stroke="currentColor" stroke-width="1.6"/><path d="M7.5 12.5l3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  github: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.1c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.09 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.13v3.16c0 .31.2.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>`,
  arrow: `<svg class="arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  terminal: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l6-5-6-5M12 19h8"/></svg>`,
  upload: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>`,
  package: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8"/></svg>`,
};

export interface LayoutOptions {
  title: string;
  description: string;
  body: string;
  /** Absolute URL for og:url / canonical, when known. */
  canonical?: string;
  /** Adds noindex for pages that should not be crawled (reports, thanks). */
  noindex?: boolean;
  /** Private pages (admin, client order page): tells the browser not to send this URL as a referrer anywhere. */
  noReferrer?: boolean;
}

/** UTC timestamp for tables and timelines: `2026-10-10 12:00 UTC`. */
export function when(ms: number | null | undefined): string {
  if (!ms) return '';
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/** Escapes text and keeps its line breaks. */
export function escLines(value: unknown): string {
  return esc(value).replace(/\n/g, '<br>');
}

export function layout(o: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
${o.canonical ? `<meta property="og:url" content="${esc(o.canonical)}">\n<link rel="canonical" href="${esc(o.canonical)}">` : ''}
${o.noindex ? '<meta name="robots" content="noindex">' : ''}
${o.noReferrer ? '<meta name="referrer" content="no-referrer">' : ''}
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/static/style.css?v=${STYLE_VERSION}">
</head>
<body>
<header class="nav">
  <div class="container nav-inner">
    <a class="wordmark" href="/">${ICON.mark}<span>${esc(SITE_NAME)}</span></a>
    <nav class="nav-links" aria-label="Site">
      <a class="nav-link" href="/#checks">Checks</a>
      <a class="nav-link" href="/#pricing">Pricing</a>
      <a class="nav-link nav-link-keep" href="/ship">Ship it for me</a>
      <a class="nav-pill" href="${esc(REPO_URL)}" rel="noopener">${ICON.github}<span>GitHub</span></a>
    </nav>
  </div>
</header>
<main>
${o.body}
</main>
<footer class="footer">
  <div class="container footer-inner">
    <div class="footer-brand">
      <span class="wordmark">${ICON.mark}<span>${esc(SITE_NAME)}</span></span>
      <span>MIT licensed. Uploads are deleted after the scan; reports expire after 7 days.</span>
    </div>
    <nav class="footer-links" aria-label="Footer">
      <a href="${esc(REPO_URL)}" rel="noopener">GitHub</a>
      <a href="${esc(NPM_URL)}" rel="noopener">npm</a>
      <a href="/ship">Ship it for me</a>
      <a href="/orders/find">Find my order</a>
      <a href="/health">Status</a>
    </nav>
  </div>
</footer>
<script>
(function () {
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var done = function () { var old = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = old; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    });
  });
  document.querySelectorAll('form[data-busy]').forEach(function (form) {
    form.addEventListener('submit', function () {
      var btn = form.querySelector('button[type=submit]');
      if (btn) { btn.disabled = true; btn.textContent = form.getAttribute('data-busy'); }
    });
  });
  document.querySelectorAll('.dropzone').forEach(function (zone) {
    var input = zone.querySelector('input[type=file]');
    var out = zone.querySelector('.dropzone-file');
    if (!input) return;
    input.addEventListener('change', function () { if (out) out.textContent = input.files && input.files[0] ? input.files[0].name : ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.add('is-over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove('is-over'); }); });
  });
})();
</script>
</body>
</html>`;
}

export function renderError(status: number, title: string, message: string): string {
  return layout({
    title: `${title} — ${SITE_NAME}`,
    description: message,
    noindex: true,
    body: `<section class="container narrow page-simple">
  <p class="eyebrow">Error ${status}</p>
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(message)}</p>
  <div class="actions"><a class="btn btn-primary" href="/">Back to ${esc(SITE_NAME)}</a></div>
</section>`,
  });
}
