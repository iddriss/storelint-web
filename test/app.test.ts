import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { createRateLimiter } from '../src/ratelimit.js';
import { STUB_FINDING_ID, stubScan } from '../src/scanner.js';
import type { Scanner } from '../src/scanner.js';
import { sampleProjectZip } from './zip-helper.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function harness(opts: { adminToken?: string; env?: Record<string, string> } = {}) {
  let clock = Date.UTC(2026, 9, 10, 12, 0, 0);
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const config = loadConfig({ ADMIN_TOKEN: opts.adminToken, ...opts.env });
  const store = new Store(':memory:', now);
  const scanner: Scanner = { scan: stubScan, available: false, source: 'stub' };
  const limiter = createRateLimiter({ ...config.rateLimit, now });
  const app = createApp({ store, config, scanner, limiter, now });
  return { app, store, config, advance };
}

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

function form(fields: Record<string, string>, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { ...FORM_HEADERS, ...extraHeaders },
    body: new URLSearchParams(fields).toString(),
  };
}

function zipUpload(zip: Buffer, headers: Record<string, string> = {}): RequestInit {
  const fd = new FormData();
  fd.append('file', new File([zip], 'project.zip', { type: 'application/zip' }));
  return { method: 'POST', headers, body: fd };
}

const VALID_LEAD = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  platform: 'both',
  store_links: '',
  repo_url: 'https://github.com/ada/app',
  message: 'Flutter app, deadline next week',
};

describe('GET /health', () => {
  it('returns ok', async () => {
    const { app } = harness();
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('GET /', () => {
  it('renders the landing page with CLI command, upload form, pricing and CTA', async () => {
    const { app } = harness();
    const res = await app.request('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>StoreLint — lint your app before the store does<\/title>/);
    assert.match(html, /npx github:iddriss\/storelint/);
    assert.match(html, /action="\/scan" enctype="multipart\/form-data"/);
    for (const price of ['$149', '$199', '$299', '$99']) assert.ok(html.includes(price), price);
    assert.match(html, /href="\/ship"/);
    assert.match(html, /scanner module is not installed/);
  });

  it('serves the stylesheet and refuses traversal', async () => {
    const { app } = harness();
    const res = await app.request('/static/style.css');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/css/);
    assert.match(await res.text(), /prefers-color-scheme: dark/);
    assert.equal((await app.request('/static/..%2Fpackage.json')).status, 404);
    assert.equal((await app.request('/static/nope.css')).status, 404);
  });
});

describe('/ship', () => {
  it('renders the service page with the four prices and the lead form', async () => {
    const { app } = harness();
    const html = await (await app.request('/ship?plan=play')).text();
    for (const price of ['$149', '$199', '$299', '$99']) assert.ok(html.includes(price), price);
    assert.match(html, /48-hour/);
    assert.match(html, /<option value="play" selected>/);
    assert.match(html, /name="email"/);
    assert.match(html, /href="\/ship\?plan=both#lead"/);
  });

  it('links price cards to PAY_LINK_* when set', async () => {
    const { app } = harness({ env: { PAY_LINK_BOTH: 'https://pay.example/both' } });
    const html = await (await app.request('/ship')).text();
    assert.match(html, /href="https:\/\/pay\.example\/both"/);
    assert.match(html, /href="\/ship\?plan=play#lead"/);
  });

  it('stores a valid lead (with the first X-Forwarded-For entry) and renders thanks', async () => {
    const { app, store } = harness();
    const res = await app.request('/ship', form(VALID_LEAD, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Thanks, Ada Lovelace/);
    const leads = store.listLeads();
    assert.equal(leads.length, 1);
    assert.equal(leads[0]?.name, 'Ada Lovelace');
    assert.equal(leads[0]?.email, 'ada@example.com');
    assert.equal(leads[0]?.platform, 'both');
    assert.equal(leads[0]?.repo_url, 'https://github.com/ada/app');
    assert.equal(leads[0]?.message, 'Flutter app, deadline next week');
    assert.equal(leads[0]?.ip, '203.0.113.9');
  });

  it('rejects an invalid lead and re-renders the form with errors', async () => {
    const { app, store } = harness();
    const res = await app.request('/ship', form({ ...VALID_LEAD, email: 'nope', platform: 'mars' }));
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /Enter a valid email address/);
    assert.match(html, /Pick one of the options/);
    assert.match(html, /value="Ada Lovelace"/);
    assert.equal(store.listLeads().length, 0);
  });

  it('silently drops honeypot submissions', async () => {
    const { app, store } = harness();
    const res = await app.request('/ship', form({ ...VALID_LEAD, website: 'http://spam' }));
    assert.equal(res.status, 200);
    assert.equal(store.listLeads().length, 0);
  });

  it('accepts the deep-scan waitlist with only an email', async () => {
    const { app, store } = harness();
    const res = await app.request('/ship', form({ platform: 'deepscan', email: 'w@example.com', name: '', message: 'Deep scan waitlist' }));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /on the list/);
    assert.equal(store.listLeads()[0]?.platform, 'deepscan');
  });
});

describe('GET /admin/leads', () => {
  it('requires the admin token', async () => {
    const { app, store } = harness({ adminToken: 's3cret' });
    store.insertLead({ ...VALID_LEAD, ip: '1.2.3.4' });
    assert.equal((await app.request('/admin/leads')).status, 401);
    assert.equal((await app.request('/admin/leads?token=wrong')).status, 401);
    assert.equal((await app.request('/admin/leads?token=s3cret-but-longer')).status, 401);
    const res = await app.request('/admin/leads?token=s3cret');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { count: number; leads: Array<{ email: string; created_at: string }> };
    assert.equal(body.count, 1);
    assert.equal(body.leads[0]?.email, 'ada@example.com');
    assert.match(body.leads[0]?.created_at ?? '', /^2026-10-10T12:00:00/);
  });

  it('is locked when ADMIN_TOKEN is unset', async () => {
    const { app } = harness();
    assert.equal((await app.request('/admin/leads?token=')).status, 401);
    assert.equal((await app.request('/admin/leads?token=anything')).status, 401);
  });
});

describe('scanning', () => {
  it('POST /api/scan returns the report as JSON and GET /r/:id renders it', async () => {
    const { app } = harness();
    const res = await app.request(
      '/api/scan',
      zipUpload(sampleProjectZip(), { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'storelint.embracetech.org' }),
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; url: string; report: Record<string, unknown> };
    assert.match(body.url, /^https:\/\/storelint\.iraaj\.com\/r\/[A-Za-z0-9_-]+$/);
    assert.equal(body.report.schemaVersion, 1);
    assert.deepEqual(body.report.project, { path: '.', framework: 'flutter', name: 'my_app' });
    assert.deepEqual(body.report.summary, { blocker: 0, warning: 0, info: 1, score: 100 });
    assert.equal((body.report.findings as Array<{ id: string }>)[0]?.id, STUB_FINDING_ID);

    const page = await app.request(`/r/${body.id}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /my_app/);
    assert.match(html, /Ready to submit/);
    assert.ok(html.includes(`/r/${body.id}`));
    assert.match(html, /Ship it for me/);
  });

  it('POST /scan redirects to the report page', async () => {
    const { app } = harness();
    const res = await app.request('/scan', zipUpload(sampleProjectZip()));
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location') ?? '', /^\/r\/[A-Za-z0-9_-]+$/);
  });

  it('rejects missing or invalid uploads with 400', async () => {
    const { app } = harness();
    const noFile = await app.request('/api/scan', { method: 'POST', body: new FormData() });
    assert.equal(noFile.status, 400);
    const garbage = await app.request('/api/scan', zipUpload(Buffer.from('definitely not a zip')));
    assert.equal(garbage.status, 400);
    assert.match(((await garbage.json()) as { error: string }).error, /zip/i);
  });

  it('returns 404 for unknown and expired reports, and cleanup removes them', async () => {
    const { app, store, advance, config } = harness();
    assert.equal((await app.request('/r/doesnotexist')).status, 404);
    const row = store.insertReport(JSON.stringify({ schemaVersion: 1 }));
    assert.equal((await app.request(`/r/${row.id}`)).status, 200);
    advance(8 * DAY);
    assert.equal((await app.request(`/r/${row.id}`)).status, 404);
    assert.equal(store.deleteExpiredReports(config.reportTtlMs), 1);
    assert.equal(store.countReports(), 0);
  });
});

describe('rate limiting', () => {
  it('limiter allows N hits per window then trips, and resets after the window', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
    assert.equal(limiter.hit('a').allowed, true);
    assert.equal(limiter.hit('a').allowed, true);
    assert.equal(limiter.hit('a').allowed, true);
    const denied = limiter.hit('a');
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSec, 1);
    assert.equal(limiter.hit('b').allowed, true);
    t = 1001;
    assert.equal(limiter.hit('a').allowed, true);
  });

  it('trips /scan and /api/scan after 10 requests from one IP within an hour', async () => {
    const { app, advance } = harness();
    const headers = { 'x-forwarded-for': '198.51.100.7' };
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/api/scan', { method: 'POST', headers, body: new FormData() });
      assert.equal(res.status, 400, `request ${i + 1} should pass the limiter`);
    }
    const blocked = await app.request('/api/scan', { method: 'POST', headers, body: new FormData() });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const html = await app.request('/scan', { method: 'POST', headers, body: new FormData() });
    assert.equal(html.status, 429);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    const other = await app.request('/api/scan', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.8' }, body: new FormData() });
    assert.equal(other.status, 400);
    advance(HOUR + 1);
    const again = await app.request('/api/scan', { method: 'POST', headers, body: new FormData() });
    assert.equal(again.status, 400);
  });
});
