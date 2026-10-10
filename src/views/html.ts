export const SITE_NAME = 'StoreLint';
export const SITE_TAGLINE = 'lint your app before the store does';
export const SITE_URL = 'https://storelint.embracetech.org';
export const CLI_COMMAND = 'npx @iraaj/storelint';
export const REPO_URL = 'https://github.com/iddriss/storelint';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LayoutOptions {
  title: string;
  description: string;
  body: string;
  /** Absolute URL for og:url / canonical, when known. */
  canonical?: string;
  /** Adds noindex for pages that should not be crawled (reports, thanks). */
  noindex?: boolean;
}

export function layout(o: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
${o.canonical ? `<meta property="og:url" content="${esc(o.canonical)}">\n<link rel="canonical" href="${esc(o.canonical)}">` : ''}
${o.noindex ? '<meta name="robots" content="noindex">' : ''}
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="site-header">
  <nav class="container nav">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">✓</span> ${esc(SITE_NAME)}</a>
    <div class="nav-links">
      <a href="/#scan">Scan</a>
      <a href="/#checks">Checks</a>
      <a href="/#pricing">Pricing</a>
      <a class="btn btn-sm btn-primary" href="/ship">Ship it for me</a>
    </div>
  </nav>
</header>
<main>
${o.body}
</main>
<footer class="site-footer">
  <div class="container footer-inner">
    <p>${esc(SITE_NAME)} &mdash; ${esc(SITE_TAGLINE)}. Scans run on your upload and the upload is deleted immediately; reports expire after 7 days.</p>
    <p><a href="${esc(REPO_URL)}">Source on GitHub</a> &middot; <a href="/ship">Ship-it service</a> &middot; <a href="/health">Status</a></p>
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
    body: `<section class="container narrow section">
  <p class="eyebrow">Error ${status}</p>
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(message)}</p>
  <p><a class="btn btn-primary" href="/">Back to StoreLint</a></p>
</section>`,
  });
}
