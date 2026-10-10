import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashPassword, parsePasswordHash, verifyPassword } from '../src/password.js';
import { ADMIN_PASSWORD, HOUR, MINUTE, TEAM, form, harness, login, payOrder, startCheckout } from './helpers.js';

const DAY = 24 * HOUR;

describe('password hashing', () => {
  it('produces scrypt:16384:8:1:<salt>:<hash> and verifies only the right password', async () => {
    const hash = await hashPassword('s3cret-pass');
    assert.match(hash, /^scrypt:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    assert.equal(await verifyPassword('s3cret-pass', hash), true);
    assert.equal(await verifyPassword('s3cret-pasS', hash), false);
    assert.equal(await verifyPassword('', hash), false);
    assert.notEqual(await hashPassword('s3cret-pass'), hash, 'salted');
  });

  it('rejects malformed hashes instead of throwing', async () => {
    for (const bad of ['', 'plain', 'scrypt:16384:8:1:abc', 'scrypt:16385:8:1:c2FsdHNhbHQ:aGFzaGhhc2hoYXNoaGFzaA', 'bcrypt:1:2:3:c2FsdHNhbHQ:aGFzaGhhc2hoYXNoaGFzaA', 'scrypt:16384:8:1:$$$:###']) {
      assert.equal(parsePasswordHash(bad), undefined, bad);
      assert.equal(await verifyPassword('x', bad), false, bad);
    }
  });

  it('the hash-password script reads stdin and prints a hash that verifies', async () => {
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/hash-password.js');
    const run = (input: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = execFile(process.execPath, [script], (err, stdout, stderr) => resolve({ code: err ? (child.exitCode ?? 1) : 0, stdout, stderr }));
        child.stdin?.end(input);
      });
    const ok = await run('a long enough password\n');
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^scrypt:16384:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\n$/);
    assert.doesNotMatch(ok.stdout + ok.stderr, /a long enough password/, 'the password is never echoed');
    assert.equal(await verifyPassword('a long enough password', ok.stdout.trim()), true);
    const short = await run('short');
    assert.notEqual(short.code, 0);
    assert.equal(short.stdout, '');
  });
});

describe('admin login', () => {
  it('shows a login form instead of the dashboard, with private-page headers', async () => {
    const h = harness();
    const res = await h.app.request('/admin');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<form[^>]+action="\/admin\/login"/);
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /Needs attention/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  it('signs in with the right password and sets a locked-down session cookie', async () => {
    const h = harness();
    const res = await h.app.request('/admin/login', form({ password: ADMIN_PASSWORD }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin');
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^sl_admin=[A-Za-z0-9_-]{43}; /);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/admin', 'Max-Age=43200']) assert.ok(cookie.includes(attr), attr);

    const dash = await h.app.request('/admin', { headers: { cookie: cookie.split(';')[0]! } });
    assert.equal(dash.status, 200);
    const html = await dash.text();
    assert.match(html, /Needs attention/);
    assert.match(html, /Log out/);
    assert.equal(dash.headers.get('cache-control'), 'no-store');
    assert.equal(dash.headers.get('x-robots-tag'), 'noindex');
    assert.equal(dash.headers.get('referrer-policy'), 'no-referrer');
  });

  it('stores only a hash of the session id', async () => {
    const h = harness();
    const admin = await login(h);
    const id = admin.cookie.replace('sl_admin=', '');
    assert.equal(h.store.getSession(id), undefined, 'the raw id is not a key');
    const { createHash } = await import('node:crypto');
    assert.ok(h.store.getSession(createHash('sha256').update(id).digest('hex')));
  });

  it('rejects a wrong password with a generic message and no cookie', async () => {
    const h = harness();
    for (const password of ['wrong', '', `${ADMIN_PASSWORD} `, ADMIN_PASSWORD.slice(0, -1)]) {
      const res = await h.app.request('/admin/login', form({ password }, { 'x-forwarded-for': `203.0.113.${password.length}` }));
      assert.equal(res.status, 401, JSON.stringify(password));
      assert.equal(res.headers.get('set-cookie'), null);
      assert.match(await res.text(), /Sign-in failed\. Check the password and try again\./);
    }
  });

  it('accepts ADMIN_PASSWORD_HASH and prefers it over ADMIN_PASSWORD', async () => {
    const hash = await hashPassword('hashed-password');
    const h = harness({ env: { ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD: 'plain-password' } });
    assert.equal((await h.app.request('/admin/login', form({ password: 'plain-password' }))).status, 401);
    assert.equal((await h.app.request('/admin/login', form({ password: 'hashed-password' }))).status, 303);

    const fallback = harness({ env: { ADMIN_PASSWORD_HASH: 'not-a-hash', ADMIN_PASSWORD: 'plain-password' } });
    assert.equal((await fallback.app.request('/admin/login', form({ password: 'plain-password' }))).status, 303, 'a malformed hash falls back to the plain password');
  });

  it('is disabled with a 503 that names the env to set when no password is configured', async () => {
    const h = harness({ env: { ADMIN_PASSWORD: '' } });
    const page = await h.app.request('/admin');
    assert.equal(page.status, 503);
    assert.match(await page.text(), /ADMIN_PASSWORD_HASH/);
    const post = await h.app.request('/admin/login', form({ password: '' }));
    assert.equal(post.status, 503);
    assert.equal(post.headers.get('set-cookie'), null);
    assert.equal((await h.app.request('/admin/orders/sl_0000000000000000')).status, 303, 'pages still need a session');
  });

  it('rate limits sign-in to 5 failed attempts per 15 minutes per IP', async () => {
    const h = harness();
    const ip = { 'x-forwarded-for': '203.0.113.50, 10.0.0.1' };
    for (let i = 0; i < 5; i++) assert.equal((await h.app.request('/admin/login', form({ password: 'guess' }, ip))).status, 401);
    const blocked = await h.app.request('/admin/login', form({ password: ADMIN_PASSWORD }, ip));
    assert.equal(blocked.status, 429, 'even the right password waits');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.match(await blocked.text(), /Too many attempts/);
    assert.equal(blocked.headers.get('set-cookie'), null);

    assert.equal((await h.app.request('/admin/login', form({ password: ADMIN_PASSWORD }, { 'x-forwarded-for': '203.0.113.51' }))).status, 303, 'other IPs are unaffected');
    h.advance(15 * MINUTE + 1000);
    assert.equal((await h.app.request('/admin/login', form({ password: ADMIN_PASSWORD }, ip))).status, 303);
  });

  it('successful sign-ins do not count against the limit', async () => {
    const h = harness();
    for (let i = 0; i < 8; i++) await login(h, ADMIN_PASSWORD, '203.0.113.60');
  });
});

describe('admin sessions', () => {
  it('expire 12 hours after the last use, sliding forward while in use', async () => {
    const h = harness();
    const admin = await login(h);
    h.advance(11 * HOUR);
    const mid = await admin.get('/admin');
    assert.equal(mid.status, 200);
    assert.match(await mid.text(), /Needs attention/);
    assert.match(mid.headers.get('set-cookie') ?? '', /^sl_admin=.*Max-Age=43200/, 'the cookie is renewed');
    h.advance(11 * HOUR);
    assert.match(await (await admin.get('/admin')).text(), /Needs attention/, '22 h after login, still signed in');
    h.advance(12 * HOUR + 1000);
    const expired = await admin.get('/admin');
    assert.match(await expired.text(), /action="\/admin\/login"/);
    assert.equal((await admin.get('/admin/orders/sl_0000000000000000')).status, 303);
    assert.equal((await admin.post('/admin/test-email')).status, 303, 'an expired session cannot post');
    assert.equal(h.emails().length, 0);
  });

  it('logout destroys the session server-side and clears the cookie', async () => {
    const h = harness();
    const admin = await login(h);
    const res = await admin.post('/admin/logout');
    assert.equal(res.status, 303);
    assert.match(res.headers.get('set-cookie') ?? '', /^sl_admin=; .*Max-Age=0/);
    const after = await admin.get('/admin');
    assert.match(await after.text(), /action="\/admin\/login"/, 'the old cookie no longer works');
  });

  it('a made-up or malformed cookie is not a session', async () => {
    const h = harness();
    for (const cookie of ['sl_admin=', 'sl_admin=abc', `sl_admin=${'A'.repeat(43)}`, 'other=1']) {
      const res = await h.app.request('/admin', { headers: { cookie } });
      assert.match(await res.text(), /action="\/admin\/login"/, cookie);
    }
  });
});

describe('admin CSRF', () => {
  it('rejects every admin POST without the session CSRF token', async () => {
    const h = harness();
    const { order } = await payOrder(h);
    const lead = h.store.insertLead({ name: 'Grace', email: 'grace@example.com', platform: 'ios', store_links: '', repo_url: '', message: '', ip: '' });
    const admin = await login(h);
    const before = h.emails().length;
    const posts: Array<[string, Record<string, string>]> = [
      [`/admin/orders/${order.id}/stage`, { stage: 'in_progress' }],
      [`/admin/orders/${order.id}/update`, { body: 'hello' }],
      [`/admin/orders/${order.id}/note`, { body: 'hello' }],
      [`/admin/orders/${order.id}/resend-link`, {}],
      [`/admin/orders/${order.id}/email`, { email: 'x@example.com' }],
      [`/admin/orders/${order.id}/cancel`, { reason: 'x' }],
      [`/admin/leads/${lead.id}`, { status: 'won', notes: 'x' }],
      ['/admin/test-email', {}],
      ['/admin/logout', {}],
    ];
    for (const [path, fields] of posts) {
      for (const token of [undefined, '', 'wrong', admin.csrf.slice(0, -1)]) {
        const res = await h.app.request(path, form(token === undefined ? fields : { ...fields, _csrf: token }, { cookie: admin.cookie }));
        assert.equal(res.status, 403, `${path} with token ${JSON.stringify(token)}`);
      }
    }
    assert.equal(h.store.getOrder(order.id)?.stage, 'paid');
    assert.equal(h.store.getLead(lead.id)?.status, 'new');
    assert.equal(h.emails().length, before);
    assert.equal(h.store.listOrderEvents(order.id).length, 1, 'only the payment event');
    assert.equal((await admin.get('/admin')).status, 200, 'still signed in');
  });

  it('a CSRF token from another session does not work', async () => {
    const h = harness();
    const a = await login(h);
    const b = await login(h);
    assert.notEqual(a.csrf, b.csrf);
    const res = await h.app.request('/admin/test-email', form({ _csrf: b.csrf }, { cookie: a.cookie }));
    assert.equal(res.status, 403);
  });

  it('without a session, admin pages and actions redirect to the login page', async () => {
    const h = harness();
    const { order } = await payOrder(h);
    for (const path of [`/admin/orders/${order.id}`, '/admin/leads/1', '/admin/emails/1', '/admin/orders', '/admin/leads']) {
      const res = await h.app.request(path);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), '/admin', path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
    }
    const post = await h.app.request(`/admin/orders/${order.id}/stage`, form({ stage: 'live' }));
    assert.equal(post.status, 303);
    assert.equal(h.store.getOrder(order.id)?.stage, 'paid');
    assert.doesNotMatch(await (await h.app.request(`/admin?token=adm1n`)).text(), new RegExp(order.id), 'the API token is not a page password');
  });
});

describe('admin dashboard', () => {
  it('shows stat tiles, revenue by currency and the attention list', async () => {
    const h = harness();
    const { order } = await payOrder(h, 'both');
    const working = (await payOrder(h, 'play', 'bob@example.com')).order;
    h.store.setOrderStage(working.id, 'in_progress');
    h.store.insertLead({ name: 'Grace Hopper', email: 'grace@example.com', platform: 'ios', store_links: '', repo_url: '', message: 'Please ship my app', ip: '' });
    h.store.insertLead({ name: '(deep scan waitlist)', email: 'w@example.com', platform: 'deepscan', store_links: '', repo_url: '', message: '', ip: '' });
    const admin = await login(h);

    let html = await (await admin.get('/admin')).text();
    const tile = (label: string) => new RegExp(`${label}</span><span class="stat-value">([^<]+)<`).exec(html)?.[1];
    assert.equal(tile('New leads awaiting reply'), '1');
    assert.equal(tile('Paid, awaiting intake'), '1');
    assert.equal(tile('Orders in progress'), '1');
    assert.equal(tile('Revenue this month'), '$448');
    assert.equal(tile('Revenue all time'), '$448');
    assert.match(html, /Nothing is waiting on you/);
    assert.match(html, new RegExp(`href="/admin/orders/${order.id}"`));

    // A day later the unanswered lead and the missing intake need attention; so does a failed email.
    h.advance(DAY + MINUTE);
    const failed = h.outbox.enqueue({ to: 'x@example.com', subject: 'Bounced one', text: 't', html: 'h', kind: 'test' })!;
    h.store.markEmailAttemptFailed(failed.id, '550 mailbox unavailable', undefined);
    html = await (await (await login(h)).get('/admin')).text(); // the first session expired overnight
    assert.match(html, /no intake<\/span>/);
    assert.match(html, /lead waiting<\/span><a class="inline" href="\/admin\/leads\/1">Grace Hopper/);
    assert.match(html, /email failed<\/span>.*Bounced one.*550 mailbox unavailable/s);
    assert.doesNotMatch(html, new RegExp(`no intake</span><a class="inline" href="/admin/orders/${working.id}"`), 'an order past intake is not flagged');
    assert.doesNotMatch(html, /lead waiting<\/span><a[^>]+>\(deep scan waitlist\)/, 'the waitlist is not a lead to chase');
  });

  it('has Orders, Leads, Waitlist and Email log sections with status filters and search', async () => {
    const h = harness();
    const { order } = await payOrder(h, 'both');
    await h.app.request('/pay/play', form({ email: 'pending@example.com' }));
    h.store.insertLead({ name: 'Grace Hopper', email: 'grace@example.com', platform: 'ios', store_links: '', repo_url: '', message: '', ip: '' });
    const won = h.store.insertLead({ name: 'Linus', email: 'linus@example.com', platform: 'play', store_links: '', repo_url: '', message: '', ip: '' });
    h.store.updateLead(won.id, { status: 'won' });
    h.store.insertLead({ name: '(deep scan waitlist)', email: 'w@example.com', platform: 'deepscan', store_links: '', repo_url: '', message: '', ip: '' });
    const admin = await login(h);
    const page = async (query: string) => (await admin.get(`/admin?${query}`)).text();

    const orders = await page('tab=orders');
    assert.match(orders, /ada@example\.com/);
    assert.match(orders, /pending@example\.com/);
    const paidOnly = await page('tab=orders&status=paid');
    assert.match(paidOnly, new RegExp(order.id));
    assert.doesNotMatch(paidOnly, /pending@example\.com/);
    assert.match(await page('tab=orders&stage=paid'), new RegExp(order.id));
    assert.doesNotMatch(await page('tab=orders&stage=open'), new RegExp(order.id));
    const byEmail = await page('tab=orders&q=PENDING%40example');
    assert.match(byEmail, /pending@example\.com/);
    assert.doesNotMatch(byEmail, /ada@example\.com/);
    assert.match(await page(`tab=orders&q=${order.id.slice(3, 12)}`), /ada@example\.com/);
    assert.match(await page('tab=orders&q=100%25'), /No orders match/, 'LIKE wildcards are literal');

    const leads = await page('tab=leads');
    assert.match(leads, /Grace Hopper/);
    assert.match(leads, /Linus/);
    assert.doesNotMatch(leads, /w@example\.com/, 'waitlist signups have their own tab');
    const wonOnly = await page('tab=leads&status=won');
    assert.match(wonOnly, /Linus/);
    assert.doesNotMatch(wonOnly, /Grace Hopper/);
    assert.match(await page('tab=leads&q=grace'), /Grace Hopper/);

    const waitlist = await page('tab=waitlist');
    assert.match(waitlist, /w@example\.com/);
    assert.doesNotMatch(waitlist, /Grace Hopper/);

    await h.flush();
    const emails = await page('tab=emails');
    assert.match(emails, /Receipt and next steps/);
    assert.match(emails, /mail-sent/);
    assert.match(await page('tab=emails&status=failed'), /No email recorded yet/);
    assert.doesNotMatch(await page('tab=emails&q=order_paid_no_such'), /Receipt and next steps/);
  });

  it('never reflects unknown flash or filter values into the page', async () => {
    const h = harness();
    const admin = await login(h);
    const html = await (await admin.get('/admin?flash=%3Cscript%3Ealert(1)%3C/script%3E&status=%22%3E%3Cb%3E&q=%22%3E%3Cimg%20src%3Dx%3E')).text();
    assert.doesNotMatch(html, /<script>alert|<img src=x>|"><b>/);
  });
});

describe('admin order page', () => {
  it('shows plan, amounts, payment, provider reference, intake answers and the full timeline', async () => {
    const h = harness();
    const { order, page } = await payOrder(h, 'both');
    await h.app.request(`${page}/intake`, form({ app_name: 'Pocket Ledger', framework: 'expo', platform_android: '1', platform_ios: '1', code_share: 'gitlab', repo_url: 'https://gitlab.com/ada/ledger', play_account: 'yes', apple_account: 'no' }));
    const admin = await login(h);
    const res = await admin.get(`/admin/orders/${order.id}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const expected of ['Both stores', '$299', 'status-paid', order.flw_id!, 'ada@example.com', 'Pocket Ledger', 'Expo', 'Android, iOS', 'GitLab invite', 'https://gitlab.com/ada/ledger', 'Not yet', 'Payment received.', 'Intake submitted.', 'Intake received']) {
      assert.ok(html.includes(expected), expected);
    }
    assert.ok(html.includes(`https://storelint.example${page}`), 'the client link is there to copy');
    assert.equal((await admin.get('/admin/orders/sl_ffffffffffffffff')).status, 404);
    assert.equal((await admin.get('/admin/orders/..%2f..')).status, 404);
  });

  it('a stage change emails the client and appears on the client timeline', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    await h.flush();
    h.sent.length = 0;
    const admin = await login(h);

    const res = await admin.post(`/admin/orders/${order.id}/stage`, { stage: 'in_progress', reason: 'Signing is set up, building now.' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/admin/orders/${order.id}?flash=stage-set`, 'queued for delivery');
    assert.equal(h.store.getOrder(order.id)?.stage, 'in_progress');
    assert.equal(h.store.getOrder(order.id)?.status, 'paid', 'the payment status is separate from the stage');
    await h.flush();

    assert.deepEqual(h.sent.map((m) => [m.kind, m.to, m.replyTo]), [['order_update', 'ada@example.com', TEAM]]);
    assert.match(h.sent[0]!.subject, /StoreLint order update: We are working on your release/);
    assert.match(h.sent[0]!.text, /Signing is set up, building now\./);
    assert.match(h.sent[0]!.text, new RegExp(`https://storelint\\.example${page}`));

    const client = await (await h.app.request(page)).text();
    assert.match(client, /<h1>We are working on your release\.<\/h1>/);
    assert.match(client, /class="step is-current" aria-current="step">.*?In progress/);
    assert.match(client, /StoreLint team<\/span>.*?We are working on your release\.<br>Signing is set up, building now\./s);

    assert.equal((await admin.post(`/admin/orders/${order.id}/stage`, { stage: 'in_progress' })).headers.get('location'), `/admin/orders/${order.id}?flash=stage-same`);
    assert.equal((await admin.post(`/admin/orders/${order.id}/stage`, { stage: 'shipped' })).headers.get('location'), `/admin/orders/${order.id}?flash=stage-invalid`);
    await h.flush();
    assert.equal(h.sent.length, 1, 'no email for a no-op or an invalid stage');
  });

  it('needs_client requires a reason, shows it to the client as a banner and keeps the stepper position', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    const admin = await login(h);
    await admin.post(`/admin/orders/${order.id}/stage`, { stage: 'in_progress' });
    const missing = await admin.post(`/admin/orders/${order.id}/stage`, { stage: 'needs_client', reason: '  ' });
    assert.equal(missing.headers.get('location'), `/admin/orders/${order.id}?flash=reason-required`);
    assert.equal(h.store.getOrder(order.id)?.stage, 'in_progress');

    await admin.post(`/admin/orders/${order.id}/stage`, { stage: 'needs_client', reason: 'Accept the Paid Apps agreement in App Store Connect <today>.' });
    const blocked = h.store.getOrder(order.id)!;
    assert.equal(blocked.stage, 'needs_client');
    assert.equal(blocked.stage_prev, 'in_progress');
    const client = await (await h.app.request(page)).text();
    assert.match(client, /class="banner banner-warn" role="alert">.*We need something from you.*Accept the Paid Apps agreement in App Store Connect &lt;today&gt;\./s);
    assert.match(client, /stepper stepper-blocked/);
    assert.match(client, /class="step is-current" aria-current="step">.*?In progress/);
    await h.flush();
    assert.match(h.sent.at(-1)!.text, /Accept the Paid Apps agreement/);

    await admin.post(`/admin/orders/${order.id}/stage`, { stage: 'submitted' });
    const resumed = h.store.getOrder(order.id)!;
    assert.equal(resumed.needs_client_reason, '');
    assert.doesNotMatch(await (await h.app.request(page)).text(), /banner-warn/);
  });

  it('a client-visible update is emailed and shown; an internal note is neither', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    await h.flush();
    h.sent.length = 0;
    const admin = await login(h);

    assert.equal((await admin.post(`/admin/orders/${order.id}/update`, { body: 'Build 1.0.3 (12) is uploaded to the internal track.' })).headers.get('location'), `/admin/orders/${order.id}?flash=update-posted`);
    assert.equal((await admin.post(`/admin/orders/${order.id}/note`, { body: 'INTERNAL-ONLY: client is slow to answer, chase on Friday.' })).headers.get('location'), `/admin/orders/${order.id}?flash=note-added`);
    await admin.post(`/admin/orders/${order.id}/stage`, { stage: 'in_review' });
    await h.flush();

    const clientMail = h.sent.filter((m) => m.to === 'ada@example.com');
    assert.equal(clientMail.length, 2, 'the update and the stage change');
    assert.match(clientMail[0]!.text, /Build 1\.0\.3 \(12\) is uploaded/);
    for (const m of h.sent) assert.doesNotMatch(m.text + m.html + m.subject, /INTERNAL-ONLY/, `${m.kind} to ${m.to}`);
    for (const e of h.emails()) assert.doesNotMatch(e.body_text + e.body_html + e.subject, /INTERNAL-ONLY/, e.kind);

    const client = await (await h.app.request(page)).text();
    assert.match(client, /Build 1\.0\.3 \(12\) is uploaded/);
    assert.doesNotMatch(client, /INTERNAL-ONLY|chase on Friday/);
    assert.deepEqual(h.store.listOrderEvents(order.id, 'client').map((e) => e.type), ['paid', 'update', 'stage']);

    const adminPage = await (await admin.get(`/admin/orders/${order.id}`)).text();
    assert.match(adminPage, /INTERNAL-ONLY: client is slow to answer/);
    assert.match(adminPage, /badge-internal/);
    assert.equal((await admin.post(`/admin/orders/${order.id}/update`, { body: '   ' })).headers.get('location'), `/admin/orders/${order.id}?flash=empty`);
  });

  it('escapes what the team types on both pages', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    const admin = await login(h);
    await admin.post(`/admin/orders/${order.id}/update`, { body: '<script>alert(1)</script>\nsecond line' });
    await admin.post(`/admin/orders/${order.id}/note`, { body: '<img src=x onerror=alert(2)>' });
    const client = await (await h.app.request(page)).text();
    assert.match(client, /&lt;script&gt;alert\(1\)&lt;\/script&gt;<br>second line/);
    const adminPage = await (await admin.get(`/admin/orders/${order.id}`)).text();
    assert.doesNotMatch(client + adminPage, /<script>alert\(1\)|<img src=x/);
    await h.flush();
    assert.doesNotMatch(h.sent.at(-1)!.html, /<script>alert/);
  });

  it('resends the client link, and only edits the client email while it is blank or a placeholder', async () => {
    const h = harness({
      verified: (txRef, id) => ({ id: Number(id), tx_ref: txRef, status: 'successful', amount: 149, currency: 'USD', customer: { email: `orders+${txRef}@storelint.example` } }),
    });
    const { order, flwId } = await startCheckout(h, 'play', '');
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    const admin = await login(h);
    const at = (path: string) => `/admin/orders/${order.id}${path}`;

    assert.match(await (await admin.get(at(''))).text(), /No usable address on this order/);
    assert.equal((await admin.post(at('/resend-link'))).headers.get('location'), at('?flash=no-email'));
    assert.equal((await admin.post(at('/email'), { email: 'nope' })).headers.get('location'), at('?flash=email-invalid'));
    assert.equal((await admin.post(at('/email'), { email: 'real@example.com' })).headers.get('location'), at('?flash=email-saved'));
    assert.equal(h.store.getOrder(order.id)?.email, 'real@example.com');
    assert.equal((await admin.post(at('/email'), { email: 'other@example.com' })).headers.get('location'), at('?flash=email-locked'));
    assert.equal(h.store.getOrder(order.id)?.email, 'real@example.com');

    await h.flush();
    h.sent.length = 0;
    assert.equal((await admin.post(at('/resend-link'))).headers.get('location'), at('?flash=link-sent'));
    await h.flush();
    assert.deepEqual(h.sent.map((m) => [m.kind, m.to]), [['order_links', 'real@example.com']]);
    assert.match(h.sent[0]!.text, new RegExp(`/o/${order.id}/${h.store.getOrder(order.id)!.access_token}`));
    assert.ok(h.store.listOrderEvents(order.id).some((e) => e.type === 'link' && e.visibility === 'internal'));
  });

  it('cancelling marks the stage, tells the client, and a refund leaves the revenue totals', async () => {
    const h = harness();
    const { order, page } = await payOrder(h, 'both');
    await payOrder(h, 'fix', 'bob@example.com');
    await h.flush();
    h.sent.length = 0;
    const admin = await login(h);
    assert.deepEqual(h.store.revenue(), [{ currency: 'USD', cents: 39800, orders: 2 }]);

    const res = await admin.post(`/admin/orders/${order.id}/cancel`, { reason: 'App is a web wrapper; it would be rejected.', refunded: '1' });
    assert.equal(res.headers.get('location'), `/admin/orders/${order.id}?flash=cancelled`);
    const cancelled = h.store.getOrder(order.id)!;
    assert.equal(cancelled.stage, 'cancelled');
    assert.equal(cancelled.status, 'paid', 'the payment record is not rewritten');
    assert.equal(cancelled.refunded_at, h.now());
    assert.deepEqual(h.store.revenue(), [{ currency: 'USD', cents: 9900, orders: 1 }]);
    await h.flush();
    assert.match(h.sent[0]!.text, /App is a web wrapper/);
    assert.match(h.sent[0]!.text, /refund was issued outside this page/);

    const client = await (await h.app.request(page)).text();
    assert.match(client, /This order is cancelled\./);
    assert.match(client, /Refunded/);
    assert.doesNotMatch(client, /action="[^"]*\/intake/, 'the intake is closed');
  });

  it('says plainly when nothing was emailed because the server has no SMTP', async () => {
    const h = harness({ mail: false });
    const { order, page } = await payOrder(h);
    const admin = await login(h);
    const at = (path: string) => `/admin/orders/${order.id}${path}`;
    assert.equal((await admin.post(at('/stage'), { stage: 'in_progress' })).headers.get('location'), at('?flash=stage-set-noemail'));
    assert.equal((await admin.post(at('/update'), { body: 'Build uploaded.' })).headers.get('location'), at('?flash=update-posted-noemail'));
    assert.equal((await admin.post(at('/resend-link'))).headers.get('location'), at('?flash=link-skipped'));
    assert.match(await (await admin.get(at('?flash=stage-set-noemail'))).text(), /No email went out/);
    assert.ok(h.emails().length >= 3 && h.emails().every((e) => e.status === 'skipped'), 'everything is on record as skipped');
    assert.match(await (await h.app.request(page)).text(), /Build uploaded\./, 'the client page still shows it');
    assert.match(await (await admin.get('/admin')).text(), /SMTP is not configured/);
  });

  it('refuses stage changes, updates and link emails on an unpaid order', async () => {
    const h = harness();
    const { order } = await startCheckout(h, 'play', 'pending@example.com');
    const admin = await login(h);
    for (const [path, fields] of [['stage', { stage: 'live' }], ['update', { body: 'x' }], ['resend-link', {}], ['cancel', {}]] as const) {
      assert.equal((await admin.post(`/admin/orders/${order.id}/${path}`, fields)).headers.get('location'), `/admin/orders/${order.id}?flash=not-paid`, path);
    }
    assert.equal(h.store.getOrder(order.id)?.stage, '');
    assert.equal(h.emails().length, 0);
    assert.match(await (await admin.get(`/admin/orders/${order.id}`)).text(), /Not paid/);
  });

  it('flags an unanswered client message until the team replies', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    const admin = await login(h);
    await h.app.request(`${page}/message`, form({ message: 'Did the invite arrive?' }));
    assert.match(await (await admin.get('/admin')).text(), /client message<\/span>/);
    await admin.post(`/admin/orders/${order.id}/note`, { body: 'checking' });
    assert.match(await (await admin.get('/admin')).text(), /client message<\/span>/, 'an internal note is not a reply');
    await admin.post(`/admin/orders/${order.id}/update`, { body: 'Yes, got it.' });
    assert.doesNotMatch(await (await admin.get('/admin')).text(), /client message<\/span>/);
  });
});

describe('admin lead page', () => {
  it('shows every field, a prefilled mailto and a copyable pay link per plan', async () => {
    const h = harness();
    const lead = h.store.insertLead({ name: 'Grace <Hopper>', email: 'grace@example.com', platform: 'ios', store_links: 'https://apps.apple.com/app/id1', repo_url: 'https://github.com/grace/app', message: 'Rejected under 4.2\nplease help', ip: '203.0.113.9' });
    const admin = await login(h);
    const html = await (await admin.get(`/admin/leads/${lead.id}`)).text();
    for (const expected of ['Grace &lt;Hopper&gt;', 'grace@example.com', 'App Store ($199)', 'https://apps.apple.com/app/id1', 'https://github.com/grace/app', 'Rejected under 4.2<br>please help', '203.0.113.9']) {
      assert.ok(html.includes(expected), expected);
    }
    assert.match(html, /href="mailto:grace@example\.com\?subject=Your%20StoreLint%20request%20\(App%20Store%20\(%24199\)\)"/);
    for (const plan of ['play', 'ios', 'both', 'fix']) assert.ok(html.includes(`data-copy="https://storelint.example/ship?plan=${plan}#prices"`), plan);
    assert.equal((await admin.get('/admin/leads/999')).status, 404);
  });

  it('saves status and internal notes', async () => {
    const h = harness();
    const lead = h.store.insertLead({ name: 'Grace', email: 'grace@example.com', platform: 'ios', store_links: '', repo_url: '', message: '', ip: '' });
    const admin = await login(h);
    const res = await admin.post(`/admin/leads/${lead.id}`, { status: 'contacted', notes: 'Called, wants a quote by Monday.' });
    assert.equal(res.headers.get('location'), `/admin/leads/${lead.id}?flash=lead-saved`);
    const saved = h.store.getLead(lead.id)!;
    assert.equal(saved.status, 'contacted');
    assert.equal(saved.notes, 'Called, wants a quote by Monday.');
    await admin.post(`/admin/leads/${lead.id}`, { status: 'bogus', notes: 'still here' });
    assert.equal(h.store.getLead(lead.id)?.status, 'contacted', 'unknown statuses are ignored');
    assert.match(await (await admin.get(`/admin/leads/${lead.id}`)).text(), /<option value="contacted" selected>/);
    assert.equal(h.emails().length, 0, 'lead notes never email anyone');
  });
});

describe('admin email log', () => {
  it('shows a message and lets a failed one be queued again', async () => {
    const h = harness();
    const admin = await login(h);
    const row = h.outbox.enqueue({ to: 'ada@example.com', subject: 'Try me', text: 'Body <text>', html: '<p>x</p>', kind: 'test' })!;
    h.store.markEmailAttemptFailed(row.id, '550 no such user', undefined);
    const html = await (await admin.get(`/admin/emails/${row.id}`)).text();
    assert.match(html, /mail-failed/);
    assert.match(html, /550 no such user/);
    assert.match(html, /Body &lt;text&gt;/);
    const retry = await admin.post(`/admin/emails/${row.id}/retry`);
    assert.equal(retry.headers.get('location'), `/admin/emails/${row.id}?flash=retry-queued`);
    await h.flush();
    assert.equal(h.store.getEmail(row.id)?.status, 'sent');
    assert.deepEqual(h.sent.map((m) => m.subject), ['Try me']);
  });
});
