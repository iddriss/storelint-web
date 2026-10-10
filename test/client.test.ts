import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSecret } from '../src/intake-form.js';
import { HOUR, MINUTE, TEAM, VALID_INTAKE, form, harness, login, payOrder, startCheckout } from './helpers.js';

describe('client order page', () => {
  it('shows plan, amount, payment status, the stepper, next steps and the intake form', async () => {
    const h = harness();
    const { order, page } = await payOrder(h, 'both');
    const res = await h.app.request(page);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const html = await res.text();
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    for (const expected of ['Both stores', '$299', 'status-paid', order.id, 'Payment received. We need the intake to start.', 'What happens next', 'Fill in the intake form below', `Invite ${TEAM} to the repository and to your store consoles`, 'Payment received.']) {
      assert.ok(html.includes(expected), expected);
    }
    assert.equal(html.match(/<li class="step /g)?.length, 6);
    assert.match(html, /class="step is-current" aria-current="step"><span class="step-dot" aria-hidden="true">1<\/span><span class="step-label">Paid/);
    assert.match(html, new RegExp(`action="${page}/intake#intake"`));
    assert.match(html, new RegExp(`action="${page}/message#messages"`));
    assert.match(html, /name="platform_android" value="1" checked/);
    assert.match(html, /name="platform_ios" value="1" checked/);
    assert.match(html, /No passwords, API keys or store logins here\./);
    assert.ok(html.includes(`mailto:${TEAM}`));
    assert.doesNotMatch(html, /type="password"/);
  });

  it('answers 404 for a wrong token, an unknown order or a malformed id, all identically', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    const wrongToken = await h.app.request(`/o/${order.id}/${'A'.repeat(43)}`);
    const unknownOrder = await h.app.request(`/o/sl_0000000000000000/${order.access_token}`);
    const malformed = await h.app.request(`/o/not-an-id/${order.access_token}`);
    const truncated = await h.app.request(page.slice(0, -1));
    const bodies = await Promise.all([wrongToken, unknownOrder, malformed, truncated].map((r) => r.text()));
    for (const res of [wrongToken, unknownOrder, malformed, truncated]) {
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-robots-tag'), 'noindex');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    }
    assert.equal(new Set(bodies).size, 1, 'no response tells an attacker whether the order exists');
    assert.doesNotMatch(bodies[0]!, new RegExp(order.id));
    assert.equal((await h.app.request(`/o/${order.id}`)).status, 404);
    assert.equal((await h.app.request(`/o/${order.id}/`)).status, 404);
    assert.equal((await h.app.request(`/o/${order.id}/${'A'.repeat(43)}/intake`, form(VALID_INTAKE))).status, 404);
    assert.equal((await h.app.request(`/o/${order.id}/${'A'.repeat(43)}/message`, form({ message: 'hi' }))).status, 404);
    assert.equal(h.store.getOrder(order.id)?.intake_json, null);
  });

  it('rate limits wrong links per IP without locking out other visitors', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    const attacker = { headers: { 'x-forwarded-for': '203.0.113.77' } };
    for (let i = 0; i < 20; i++) assert.equal((await h.app.request(`/o/${order.id}/${String(i).padStart(43, 'x')}`, attacker)).status, 404);
    const blocked = await h.app.request(`/o/${order.id}/${'y'.repeat(43)}`, attacker);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await h.app.request(page, attacker)).status, 429, 'even the right link waits from that address');
    assert.equal((await h.app.request(page, { headers: { 'x-forwarded-for': '198.51.100.5' } })).status, 200);
    for (let i = 0; i < 40; i++) assert.equal((await h.app.request(page, { headers: { 'x-forwarded-for': '198.51.100.6' } })).status, 200, 'valid visits are never counted');
    h.advance(HOUR + 1000);
    assert.equal((await h.app.request(page, attacker)).status, 200);
  });

  it('for an unpaid order shows the payment status and no forms', async () => {
    const h = harness();
    const { order } = await startCheckout(h);
    const page = `/o/${order.id}/${order.access_token}`;
    const html = await (await h.app.request(page)).text();
    assert.match(html, /Payment still pending\./);
    assert.match(html, /status-pending/);
    assert.doesNotMatch(html, /<form[^>]+\/(intake|message)/);
    assert.equal((await h.app.request(`${page}/intake`, form(VALID_INTAKE))).status, 303);
    assert.equal((await h.app.request(`${page}/message`, form({ message: 'hello' }))).status, 303);
    assert.equal(h.store.getOrder(order.id)?.intake_json, null);
    assert.equal(h.store.listOrderEvents(order.id).length, 0);
    assert.equal(h.emails().length, 0);
  });
});

describe('client intake', () => {
  it('stores valid answers, moves the stage to intake_received, logs the event and tells the team', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    await h.flush();
    h.sent.length = 0;
    const res = await h.app.request(`${page}/intake`, form(VALID_INTAKE));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${page}?done=intake#intake`);
    const saved = h.store.getOrder(order.id)!;
    assert.equal(saved.stage, 'intake_received');
    assert.equal(saved.intake_at, h.now());
    assert.deepEqual(JSON.parse(saved.intake_json ?? '{}'), {
      app_name: 'Pocket Ledger',
      framework: 'flutter',
      platforms: ['android'],
      code_share: 'github',
      repo_url: 'https://github.com/ada/pocket-ledger',
      store_urls: 'https://play.google.com/store/apps/details?id=com.ada.ledger',
      play_account: 'yes',
      apple_account: 'na',
      target_date: '2026-11-30',
      notes: 'Flutter 3.35, internal track first.',
    });
    assert.deepEqual(h.store.listOrderEvents(order.id).map((e) => [e.actor, e.type, e.visibility, e.body]), [
      ['system', 'paid', 'client', 'Payment received.'],
      ['client', 'intake', 'client', 'Intake submitted.'],
    ]);
    await h.flush();
    assert.deepEqual(h.sent.map((m) => [m.kind, m.to]), [['intake', TEAM]]);

    const html = await (await h.app.request(`${page}?done=intake`)).text();
    assert.match(html, /Intake saved\. The team has been told/);
    assert.match(html, /<h1>Intake received\. We are checking it\.<\/h1>/);
    assert.match(html, /class="step is-current" aria-current="step">.*?Intake received/);
    assert.match(html, /value="Pocket Ledger"/);
    assert.match(html, /Update intake/);
  });

  it('an update keeps the stage where the team put it', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    await h.app.request(`${page}/intake`, form(VALID_INTAKE));
    h.store.setOrderStage(order.id, 'in_progress');
    assert.equal((await h.app.request(`${page}/intake`, form({ ...VALID_INTAKE, app_name: 'Pocket Ledger 2' }))).status, 303);
    const saved = h.store.getOrder(order.id)!;
    assert.equal(saved.stage, 'in_progress');
    assert.match(saved.intake_json ?? '', /Pocket Ledger 2/);
    assert.equal(h.store.listOrderEvents(order.id).at(-1)?.body, 'Intake updated.');
  });

  it('re-renders the form with errors and saves nothing when fields are missing or malformed', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    const res = await h.app.request(`${page}/intake`, form({ app_name: '', framework: 'cobol', code_share: 'github', repo_url: 'github.com/ada/app', target_date: '2026-02-31', notes: 'kept <b>as typed</b>' }));
    assert.equal(res.status, 400);
    const html = await res.text();
    for (const expected of ['Tell us the app name.', 'Pick the framework.', 'Pick at least one platform.', 'Links must start with http:// or https://.', 'Use a date like 2026-11-30.', 'Nothing was saved yet.', 'kept &lt;b&gt;as typed&lt;/b&gt;', 'value="github.com/ada/app"']) {
      assert.ok(html.includes(expected), expected);
    }
    const saved = h.store.getOrder(order.id)!;
    assert.equal(saved.intake_json, null);
    assert.equal(saved.stage, 'paid');
    assert.equal(h.store.listOrderEvents(order.id).length, 1);
    const missingRepo = await h.app.request(`${page}/intake`, form({ ...VALID_INTAKE, repo_url: '' }));
    assert.match(await missingRepo.text(), /Add the repository or upload link\./);
    assert.equal((await h.app.request(`${page}/intake`, form({ ...VALID_INTAKE, repo_url: '', code_share: 'other' }))).status, 303, '"other" needs no link');
  });

  it('rejects anything that looks like a secret with a friendly message and stores nothing', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    await h.flush();
    const before = h.emails().length;
    // Shaped like real credentials but assembled from pieces, so no scanner mistakes this file for a leak.
    const pem = (label: string) => `-----BEGIN ${label}-----`;
    const secrets: Array<[field: string, value: string, what: RegExp]> = [
      ['notes', `${pem('RSA PRIVATE KEY')}\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----`, /a private key/],
      ['notes', pem('PRIVATE KEY'), /a private key/],
      ['notes', `token for CI: ${['gh', 'p_'].join('')}${'a1B2c3D4e5'.repeat(4)}`, /a GitHub token/],
      ['repo_url', `https://ada:${'hunter2'}secret@github.com/ada/app`, /a link with a password in it/],
      ['notes', `App Store Connect key ${'AKIA'}${'IOSFODNN7'}EXAMPLE`, /an AWS access key/],
      ['notes', 'Play login is ada@example.com, password: Tr0ub4dor&3', /a password/],
      ['notes', `the api key is ${'Zx9Kq2Lm8Pv4Rt6Y'}${'w1Nb3Hc5Jd7Fg0SaQe'}`, /a long key or token/],
      ['store_urls', [`eyJ${'hbGciOiJIUzI1NiJ9'}`, `eyJ${'zdWIiOiIxMjM0NTY3ODkwIn0'}`, 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.'), /a signed token/],
      ['app_name', ['sk', 'live', `4eC39HqLyjWD${'arjtT1zdp7dc'}`].join('_'), /a payment API key/],
    ];
    for (const [field, value, what] of secrets) {
      const res = await h.app.request(`${page}/intake`, form({ ...VALID_INTAKE, [field]: value }));
      assert.equal(res.status, 400, `${field}: ${value.slice(0, 30)}`);
      const html = await res.text();
      assert.match(html, what, value.slice(0, 30));
      assert.match(html, /we never need secrets here/);
      assert.ok(html.includes(`Invite ${TEAM} to the repo and store consoles instead.`));
    }
    const saved = h.store.getOrder(order.id)!;
    assert.equal(saved.intake_json, null, 'nothing secret-looking ever reaches the database');
    assert.equal(saved.stage, 'paid');
    assert.equal(h.emails().length, before, 'and nothing is emailed');
  });

  it('accepts ordinary links, commit hashes and prose', () => {
    for (const fine of [
      '',
      'Ship commit 3f2a9c1e7b4d5f60718293a4b5c6d7e8f9a0b1c2 from the release branch.',
      'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view?usp=sharing',
      'https://play.google.com/store/apps/details?id=com.example.superlongpackagename.production.release',
      'We share the demo password through 1Password, password: 1Password link to follow.',
      'my_app_release_build_2026_10_10_final_version.zip is in the shared folder',
      'SHA-256 fingerprint: FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
      'Contact +2348012345678 or +233201234567 for review questions; bundle id com.ada.ledger',
    ]) {
      assert.equal(findSecret(fine), undefined, fine);
    }
    assert.equal(findSecret('d41d8cd98f00b204e9800998ecf8427e'), 'a long key or token', '32 hex characters is an API-key shape');
  });

  it('locks the intake once the build is submitted', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    await h.app.request(`${page}/intake`, form(VALID_INTAKE));
    h.store.setOrderStage(order.id, 'submitted');
    const res = await h.app.request(`${page}/intake`, form({ ...VALID_INTAKE, app_name: 'Changed' }));
    assert.equal(res.status, 303);
    assert.doesNotMatch(h.store.getOrder(order.id)?.intake_json ?? '', /Changed/);
    const html = await (await h.app.request(page)).text();
    assert.doesNotMatch(html, /action="[^"]*\/intake/);
    assert.match(html, /Locked now that the build is submitted/);
    assert.match(html, /Pocket Ledger/);
    assert.match(html, /<h1>Submitted to the store\.<\/h1>/);

    h.store.setOrderStage(order.id, 'needs_client', 'Wrong repository');
    assert.match(await (await h.app.request(page)).text(), /action="[^"]*\/intake/, 'a blocked order can be edited again');
  });
});

describe('client messages', () => {
  it('stores the message as a client event, shows it escaped and emails the team', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    await h.flush();
    h.sent.length = 0;
    const text = 'Invited you.\n<script>alert("x")</script> & thanks';
    const res = await h.app.request(`${page}/message`, form({ message: text }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${page}?done=message#updates`);
    assert.deepEqual(h.store.listOrderEvents(order.id).at(-1), { id: 2, order_id: order.id, created_at: h.now(), actor: 'client', type: 'message', visibility: 'client', body: text });
    const html = await (await h.app.request(`${page}?done=message`)).text();
    assert.match(html, /Message sent to the team\./);
    assert.match(html, /You<\/span>.*Invited you\.<br>&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; thanks/s);
    assert.doesNotMatch(html, /<script>alert/);
    await h.flush();
    assert.deepEqual(h.sent.map((m) => [m.kind, m.to, m.replyTo]), [['client_message', TEAM, 'ada@example.com']]);
    assert.doesNotMatch(h.sent[0]!.html, /<script>alert/);
    const admin = await login(h);
    assert.doesNotMatch(await (await admin.get(`/admin/orders/${order.id}`)).text(), /<script>alert/);
  });

  it('refuses request bodies far beyond any form the pages render', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    const res = await h.app.request(`${page}/message`, form({ message: 'x'.repeat(200 * 1024) }));
    assert.equal(res.status, 413);
    assert.equal((await h.app.request('/orders/find', form({ email: `${'a'.repeat(200 * 1024)}@example.com` }))).status, 413);
    assert.equal((await h.app.request('/admin/login', form({ password: 'p'.repeat(200 * 1024) }))).status, 413);
    assert.equal(h.store.countOrderEvents(order.id, 'client', 'message', 0), 0);
  });

  it('rejects empty, oversized and secret-bearing messages', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    const post = (message: string) => h.app.request(`${page}/message`, form({ message }));
    const empty = await post('   ');
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /Write a message first\./);
    const long = await post('x'.repeat(4001));
    assert.equal(long.status, 400);
    assert.match(await long.text(), /limited to 4000 characters/);
    const secret = await post(`here is the key -----BEGIN ${'OPENSSH'} PRIVATE KEY-----`);
    assert.equal(secret.status, 400);
    assert.match(await secret.text(), /a private key/);
    assert.equal((await post('x'.repeat(4000))).status, 303);
    assert.equal(h.store.countOrderEvents(order.id, 'client', 'message', 0), 1);
  });

  it('is limited to 10 messages per hour per order', async () => {
    const h = harness();
    const a = await payOrder(h);
    const b = await payOrder(h, 'fix', 'bob@example.com');
    for (let i = 0; i < 10; i++) {
      assert.equal((await h.app.request(`${a.page}/message`, form({ message: `message ${i}` }, { 'x-forwarded-for': `203.0.113.${i}` }))).status, 303);
      h.advance(MINUTE);
    }
    const blocked = await h.app.request(`${a.page}/message`, form({ message: 'one too many' }));
    assert.equal(blocked.status, 429);
    assert.match(await blocked.text(), /10 messages in an hour/);
    assert.equal(h.store.countOrderEvents(a.order.id, 'client', 'message', 0), 10);
    assert.equal((await h.app.request(`${b.page}/message`, form({ message: 'other order' }))).status, 303, 'the limit is per order');
    h.advance(51 * MINUTE);
    assert.equal((await h.app.request(`${a.page}/message`, form({ message: 'an hour later' }))).status, 303);
    await h.flush();
    assert.equal(h.emailsOf('client_message').length, 12);
  });
});

describe('find my order', () => {
  const find = (h: ReturnType<typeof harness>, email: string, ip = '198.51.100.9') => h.app.request('/orders/find', form({ email, website: '' }, { 'x-forwarded-for': ip }));

  it('answers identically whether or not the address has orders, and emails only real ones', async () => {
    const h = harness();
    const first = await payOrder(h, 'play');
    h.advance(MINUTE);
    const second = await payOrder(h, 'fix');
    await startCheckout(h, 'both', 'pending@example.com');
    await h.flush();
    h.sent.length = 0;

    const known = await find(h, 'ADA@example.com');
    const unknown = await find(h, 'nobody@example.com');
    const unpaid = await find(h, 'pending@example.com');
    assert.deepEqual([known.status, unknown.status, unpaid.status], [200, 200, 200]);
    const [a, b, c] = await Promise.all([known.text(), unknown.text(), unpaid.text()]);
    assert.equal(a, b);
    assert.equal(a, c);
    assert.match(a, /If we have orders for that address, we just emailed the link\(s\)\./);
    assert.doesNotMatch(a, /ada@example|sl_[0-9a-f]{16}/i);
    assert.deepEqual([...known.headers.entries()].sort(), [...unknown.headers.entries()].sort());

    await h.flush();
    assert.deepEqual(h.sent.map((m) => [m.kind, m.to]), [['order_links', 'ada@example.com']], 'sent to the stored address');
    assert.match(h.sent[0]!.text, new RegExp(`https://storelint\\.example${first.page}`));
    assert.match(h.sent[0]!.text, new RegExp(`https://storelint\\.example${second.page}`));
    assert.doesNotMatch(h.sent[0]!.text, /pending@example/);
  });

  it('sends at most one links email per address every ten minutes', async () => {
    const h = harness();
    await payOrder(h);
    for (let i = 0; i < 4; i++) assert.equal((await find(h, 'ada@example.com', `198.51.100.${i}`)).status, 200);
    assert.equal(h.emailsOf('order_links').length, 1);
    h.advance(11 * MINUTE);
    await find(h, 'ada@example.com', '198.51.100.50');
    assert.equal(h.emailsOf('order_links').length, 2);
  });

  it('is rate limited per IP and ignores bots', async () => {
    const h = harness();
    await payOrder(h);
    for (let i = 0; i < 5; i++) assert.equal((await find(h, `nobody${i}@example.com`)).status, 200);
    const blocked = await find(h, 'ada@example.com');
    assert.equal(blocked.status, 429);
    assert.equal(h.emailsOf('order_links').length, 0);
    const bot = await h.app.request('/orders/find', form({ email: 'ada@example.com', website: 'http://spam' }, { 'x-forwarded-for': '198.51.100.99' }));
    assert.equal(bot.status, 200);
    assert.equal(h.emailsOf('order_links').length, 0);
    const invalid = await find(h, 'not-an-email', '198.51.100.98');
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Enter a valid email address\./);
  });

  it('has a page, a form on /ship and a footer link', async () => {
    const h = harness();
    const page = await h.app.request('/orders/find');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<form[^>]+action="\/orders\/find"/);
    const ship = await (await h.app.request('/ship')).text();
    assert.match(ship, /Already paid\?/);
    assert.match(ship, /<form class="inline-form find-form" method="post" action="\/orders\/find"/);
    assert.match(await (await h.app.request('/')).text(), /<a href="\/orders\/find">Find my order<\/a>/);
  });

  it('says so, for every address alike, when the server cannot send mail', async () => {
    const h = harness({ mail: false });
    await payOrder(h);
    const known = await (await find(h, 'ada@example.com')).text();
    const unknown = await (await find(h, 'nobody@example.com')).text();
    assert.equal(known, unknown);
    assert.match(known, /cannot be emailed from this server right now/);
    assert.ok(known.includes(TEAM));
    assert.doesNotMatch(known, /we just emailed/);
    assert.equal(h.emailsOf('order_links').length, 0);
  });
});

describe('GET /pay/return for a paid order', () => {
  const returnUrl = (order: { id: string }, flwId: string) => `/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`;

  it('redirects to the private page while the payment is fresh, even without the checkout cookie', async () => {
    const h = harness();
    const { order, flwId } = await startCheckout(h);
    const res = await h.app.request(returnUrl(order, flwId));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/o/${order.id}/${order.access_token}`);
    h.advance(29 * MINUTE);
    assert.equal((await h.app.request(returnUrl(order, flwId))).status, 303);
  });

  it('later on, only the browser that started the checkout is redirected', async () => {
    const h = harness();
    const { order, flwId, payCookie } = await startCheckout(h);
    assert.match(payCookie, new RegExp(`^sl_pay=${order.id}\\.[A-Za-z0-9_-]{43}$`));
    await h.app.request(returnUrl(order, flwId));
    h.advance(31 * MINUTE);

    const own = await h.app.request(returnUrl(order, flwId), { headers: { cookie: payCookie } });
    assert.equal(own.status, 303);
    assert.equal(own.headers.get('location'), `/o/${order.id}/${order.access_token}`);

    for (const cookie of ['', `sl_pay=${order.id}.${'A'.repeat(43)}`, `sl_pay=sl_0000000000000000.${payCookie.split('.')[1]}`]) {
      const res = await h.app.request(returnUrl(order, flwId), { headers: cookie ? { cookie } : {} });
      assert.equal(res.status, 200, cookie);
      const html = await res.text();
      assert.match(html, /This order is paid\./);
      assert.match(html, /emailed to the address on this order/);
      assert.doesNotMatch(html, new RegExp(order.access_token), 'knowing the order id alone never reveals the private link');
    }
  });

  it('sets the checkout cookie HttpOnly, Secure and SameSite=Lax so it survives the trip back from the provider', async () => {
    const h = harness();
    const res = await h.app.request('/pay/play', form({ email: 'ada@example.com' }));
    const cookie = res.headers.get('set-cookie') ?? '';
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/pay']) assert.ok(cookie.includes(attr), attr);
  });

  it('does not claim an email was sent when the server cannot send mail', async () => {
    const h = harness({ mail: false });
    const { order, flwId } = await startCheckout(h);
    await h.app.request(returnUrl(order, flwId));
    h.advance(HOUR);
    const html = await (await h.app.request(returnUrl(order, flwId))).text();
    assert.doesNotMatch(html, /were emailed/);
    assert.ok(html.includes(`write to ${TEAM}`));
  });
});
