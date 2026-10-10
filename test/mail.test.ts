import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeSmtp, loadConfig, loadSmtpConfig } from '../src/config.js';
import { MAX_ATTEMPTS, SKIP_NOT_CONFIGURED, SKIP_UNDELIVERABLE } from '../src/mailer.js';
import { HOUR, MINUTE, TEAM, form, harness, login, payOrder, startCheckout, VALID_INTAKE } from './helpers.js';

const MESSAGE = { to: 'ada@example.com', subject: 'Hello', text: 'plain', html: '<p>plain</p>', kind: 'test' };

describe('SMTP configuration', () => {
  it('uses implicit TLS on 465 and required STARTTLS elsewhere, except port 25', () => {
    const on = (port: string) => loadSmtpConfig({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: port, SMTP_USER: 'u@example.com', SMTP_PASS: 'p' });
    assert.deepEqual([on('465').secure, on('465').requireTLS], [true, false]);
    assert.deepEqual([on('587').secure, on('587').requireTLS], [false, true]);
    assert.deepEqual([on('2525').secure, on('2525').requireTLS], [false, true]);
    assert.deepEqual([on('25').secure, on('25').requireTLS], [false, false]);
    assert.equal(loadSmtpConfig({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u@example.com', SMTP_PASS: 'p' }).port, 587);
  });

  it('defaults the From address to SMTP_USER, the name to StoreLint and notifications to the team address', () => {
    const c = loadConfig({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'robot@example.com', SMTP_PASS: 'p' });
    assert.equal(c.smtp.from, 'robot@example.com');
    assert.equal(c.smtp.fromName, 'StoreLint');
    assert.equal(c.smtp.configured, true);
    assert.equal(c.notifyEmail, TEAM);
    const custom = loadConfig({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'hello@example.com', SMTP_FROM_NAME: 'Release Ops', NOTIFY_EMAIL: 'ops@example.com' });
    assert.equal(custom.smtp.from, 'hello@example.com');
    assert.equal(custom.smtp.fromName, 'Release Ops');
    assert.equal(custom.notifyEmail, 'ops@example.com');
  });

  it('treats unresolved templates and missing pieces as not configured', () => {
    assert.equal(loadSmtpConfig({}).configured, false);
    assert.equal(loadSmtpConfig({ SMTP_HOST: '{{ smtp.host }}', SMTP_USER: 'u@example.com', SMTP_PASS: 'p' }).configured, false);
    assert.equal(loadSmtpConfig({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u@example.com', SMTP_PASS: '{{SMTP_PASS}}' }).configured, false, 'a user without a password cannot authenticate');
    assert.equal(loadSmtpConfig({ SMTP_HOST: 'smtp.example.com', SMTP_USER: '{{user}}', SMTP_PASS: 'p' }).configured, false, 'no From address');
    assert.equal(loadConfig({ NOTIFY_EMAIL: '{{ notify }}' }).notifyEmail, TEAM);
  });

  it('describes the setup in one line without printing any value that could be a secret', () => {
    const line = describeSmtp(loadSmtpConfig({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'robot@example.com', SMTP_PASS: 'hunter2-very-secret' }));
    assert.match(line, /configured/);
    assert.match(line, /host=smtp\.example\.com port=465/);
    assert.match(line, /user=yes pass=yes/);
    assert.doesNotMatch(line, /hunter2|robot@example\.com/);
    assert.doesNotMatch(line, /\n/);
    assert.match(describeSmtp(loadSmtpConfig({})), /not configured.*user=no pass=no/);
  });
});

describe('outbox', () => {
  it('queues a message and the worker sends it with From, Reply-To and both bodies', async () => {
    const h = harness();
    const row = h.outbox.enqueue({ ...MESSAGE, replyTo: 'client@example.com', relatedType: 'order', relatedId: 'sl_1' });
    assert.equal(row?.status, 'queued');
    assert.equal(h.sent.length, 0, 'enqueue does not send inline');
    await h.flush();
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0], {
      from: { name: 'StoreLint', address: 'no-reply@storelint.example' },
      to: 'ada@example.com',
      replyTo: 'client@example.com',
      subject: 'Hello',
      text: 'plain',
      html: '<p>plain</p>',
      kind: 'test',
    });
    const stored = h.store.getEmail(row!.id)!;
    assert.equal(stored.status, 'sent');
    assert.equal(stored.attempts, 1);
    assert.equal(stored.sent_at, h.now());
    assert.equal(stored.related_id, 'sl_1');
    await h.flush();
    assert.equal(h.sent.length, 1, 'a sent message is never sent twice');
  });

  it('retries a failed send with backoff and records the error', async () => {
    const h = harness();
    const row = h.outbox.enqueue(MESSAGE)!;
    h.failNext(2);
    await h.flush();
    let stored = h.store.getEmail(row.id)!;
    assert.equal(stored.status, 'queued');
    assert.equal(stored.attempts, 1);
    assert.match(stored.last_error ?? '', /451/);
    assert.equal(stored.next_attempt_at, h.now() + MINUTE);

    await h.flush();
    assert.equal(h.store.getEmail(row.id)!.attempts, 1, 'not retried before the backoff has passed');

    h.advance(MINUTE);
    await h.flush();
    stored = h.store.getEmail(row.id)!;
    assert.equal(stored.attempts, 2);
    assert.equal(stored.next_attempt_at, h.now() + 5 * MINUTE);

    h.advance(5 * MINUTE);
    await h.flush();
    stored = h.store.getEmail(row.id)!;
    assert.equal(stored.status, 'sent');
    assert.equal(stored.attempts, 3);
    assert.equal(stored.last_error, null);
    assert.equal(h.sent.length, 1);
  });

  it('gives up after five attempts and marks the message failed', async () => {
    const h = harness();
    const row = h.outbox.enqueue(MESSAGE)!;
    h.failNext(99);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await h.flush();
      h.advance(2 * HOUR);
    }
    const stored = h.store.getEmail(row.id)!;
    assert.equal(stored.status, 'failed');
    assert.equal(stored.attempts, MAX_ATTEMPTS);
    assert.match(stored.last_error ?? '', /Temporary failure/);
    assert.equal(h.sent.length, 0);
    assert.equal(h.store.dueEmails().length, 0);
  });

  it('records mail as skipped when SMTP is not configured', async () => {
    const h = harness({ mail: false });
    assert.equal(h.outbox.configured, false);
    const row = h.outbox.enqueue(MESSAGE)!;
    assert.equal(row.status, 'skipped');
    assert.equal(row.last_error, SKIP_NOT_CONFIGURED);
    await h.flush();
    assert.equal(h.store.getEmail(row.id)!.status, 'skipped');
    assert.equal(h.sent.length, 0);
  });

  it('never sends to placeholder or invalid addresses', async () => {
    const h = harness();
    const placeholder = h.outbox.enqueue({ ...MESSAGE, to: 'orders+sl_0123456789abcdef@storelint.example' })!;
    assert.equal(placeholder.status, 'skipped');
    assert.equal(placeholder.last_error, SKIP_UNDELIVERABLE);
    assert.equal(h.outbox.enqueue({ ...MESSAGE, to: 'not-an-address' })?.status, 'skipped');
    assert.equal(h.outbox.enqueue({ ...MESSAGE, to: '' }), undefined);
    assert.equal(h.outbox.enqueue({ ...MESSAGE, replyTo: 'orders+sl_0123456789abcdef@storelint.example' })?.reply_to, '', 'a placeholder is not a Reply-To either');
    await h.flush();
    assert.deepEqual(h.sent.map((m) => m.to), ['ada@example.com']);
  });

  it('strips line breaks from subjects and addresses', async () => {
    const h = harness();
    const row = h.outbox.enqueue({ ...MESSAGE, subject: 'Hello\r\nBcc: evil@example.com' })!;
    assert.equal(row.subject, 'Hello Bcc: evil@example.com');
    assert.equal(h.outbox.enqueue({ ...MESSAGE, to: 'ada@example.com\r\nBcc: evil@example.com' })?.status, 'skipped');
  });

  it('never throws into the request, even when storage breaks', async () => {
    const h = harness();
    h.store.close();
    assert.equal(h.outbox.enqueue(MESSAGE), undefined);
  });

  it('a slow or failing transport never blocks or fails the HTTP request', async () => {
    const h = harness();
    h.failNext(99);
    const res = await h.app.request('/ship', form({ name: 'Ada', email: 'ada@example.com', platform: 'both', message: 'hi' }));
    assert.equal(res.status, 200);
    assert.equal(h.store.listLeads().length, 1);
    await h.flush();
    assert.ok(h.emails().every((e) => e.status === 'queued' && e.attempts === 1));
  });
});

describe('notifications', () => {
  it('a service lead notifies the team (Reply-To the lead) and acknowledges the lead', async () => {
    const h = harness();
    await h.app.request('/ship', form({ name: 'Ada Lovelace', email: 'ada@example.com', platform: 'both', repo_url: 'https://github.com/ada/app', message: 'Flutter app <b>urgent</b>' }));
    await h.flush();
    assert.deepEqual(h.emails().map((e) => [e.kind, e.to_addr, e.reply_to, e.status]), [
      ['lead_new', TEAM, 'ada@example.com', 'sent'],
      ['lead_ack', 'ada@example.com', TEAM, 'sent'],
    ]);
    const [team, ack] = h.sent;
    assert.match(team!.subject, /New lead: Ada Lovelace \(Both stores/);
    assert.match(team!.text, /https:\/\/storelint\.example\/admin\/leads\/1/);
    assert.match(team!.text, /Flutter app <b>urgent<\/b>/);
    assert.match(team!.html, /Flutter app &lt;b&gt;urgent&lt;\/b&gt;/, 'HTML bodies escape what people typed');
    assert.doesNotMatch(team!.html, /<img|<script|<link|url\(/i, 'no remote assets');
    assert.match(ack!.subject, /We received your request/);
    assert.match(ack!.text, /A developer replies within one business day/);
    assert.equal(h.emails()[0]?.related_type, 'lead');
    assert.equal(h.emails()[0]?.related_id, '1');
  });

  it('a waitlist signup gets a one-line confirmation, not the service acknowledgement', async () => {
    const h = harness();
    await h.app.request('/ship', form({ platform: 'deepscan', email: 'w@example.com', name: '', message: 'Deep scan waitlist' }));
    await h.flush();
    assert.deepEqual(h.emails().map((e) => [e.kind, e.to_addr]), [
      ['waitlist_new', TEAM],
      ['waitlist_ack', 'w@example.com'],
    ]);
    assert.doesNotMatch(h.sent[1]!.text, /24 hours/);
    assert.match(h.sent[1]!.text, /once binary deep scans/);
  });

  it('acknowledges one address at most once per ten minutes and rate limits the form per IP', async () => {
    const h = harness();
    const lead = (i: number, ip: string) => h.app.request('/ship', form({ name: `Ada ${i}`, email: 'victim@example.com', platform: 'both' }, { 'x-forwarded-for': ip }));
    for (let i = 0; i < 3; i++) assert.equal((await lead(i, `203.0.113.${i}`)).status, 200);
    assert.equal(h.emailsOf('lead_new').length, 3, 'the team hears about every lead');
    assert.equal(h.emailsOf('lead_ack').length, 1, 'the address is not flooded');
    h.advance(11 * MINUTE);
    await lead(3, '203.0.113.3');
    assert.equal(h.emailsOf('lead_ack').length, 2);

    for (let i = 0; i < 10; i++) assert.equal((await lead(i, '203.0.113.200')).status, 200);
    const blocked = await lead(11, '203.0.113.200');
    assert.equal(blocked.status, 429);
    assert.match(await blocked.text(), /10 requests per hour/);
    assert.equal(h.store.listLeads().length, 14);
    assert.equal((await h.app.request('/ship')).status, 200, 'reading the page is never limited');
  });

  it('refuses address-list syntax in recipient addresses', async () => {
    const h = harness();
    for (const to of ['a@b.co,evil@example.com', 'a@b.co,c.d', '<a@b.co>', '"x"@b.co;c.d']) assert.equal(h.outbox.enqueue({ ...MESSAGE, to })?.status ?? 'none', 'skipped', to);
    await h.flush();
    assert.equal(h.sent.length, 0);
  });

  it('honeypot and invalid submissions send nothing', async () => {
    const h = harness();
    await h.app.request('/ship', form({ name: 'Bot', email: 'bot@example.com', platform: 'both', website: 'http://spam' }));
    await h.app.request('/ship', form({ name: 'Ada', email: 'nope', platform: 'both' }));
    assert.equal(h.emails().length, 0);
  });

  it('a paid order sends the team a notice and the client a receipt with their private link, exactly once', async () => {
    const h = harness();
    const { order, flwId } = await startCheckout(h, 'both');
    assert.equal(h.emails().length, 0, 'nothing is sent before the payment verifies');
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    // The webhook arrives as well, and the buyer reloads the return page.
    await h.app.request('/webhooks/flutterwave', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'verif-hash': 'whsec-test-hash' },
      body: JSON.stringify({ event: 'charge.completed', data: { id: Number(flwId), tx_ref: order.id, status: 'successful' } }),
    });
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    await h.flush();

    const paid = h.store.getOrder(order.id)!;
    assert.deepEqual(h.emails().map((e) => [e.kind, e.to_addr, e.reply_to]), [
      ['order_paid', TEAM, 'ada@example.com'],
      ['order_receipt', 'ada@example.com', TEAM],
    ]);
    const [team, receipt] = h.sent;
    assert.match(team!.subject, /Order paid: Both stores \$299 \(ada@example\.com\)/);
    assert.match(team!.text, new RegExp(`https://storelint\\.example/admin/orders/${order.id}`));
    assert.doesNotMatch(team!.text, new RegExp(paid.access_token), 'the internal notice links to the admin page, not the client secret');
    assert.match(receipt!.subject, /Receipt and next steps: Both stores \(\$299\)/);
    assert.match(receipt!.text, new RegExp(`https://storelint\\.example/o/${order.id}/${paid.access_token}`));
    assert.match(receipt!.html, new RegExp(`href="https://storelint\\.example/o/${order.id}/${paid.access_token}"`));
    assert.match(receipt!.text, /Fill in the intake form/);
    assert.match(receipt!.text, new RegExp(`Invite ${TEAM}`));
  });

  it('an order paid with no usable email notifies the team only', async () => {
    const h = harness({
      verified: (txRef, id) => ({ id: Number(id), tx_ref: txRef, status: 'successful', amount: 99, currency: 'USD', customer: { email: `orders+${txRef}@storelint.example` } }),
    });
    const { order, flwId } = await startCheckout(h, 'fix', '');
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    await h.flush();
    assert.deepEqual(h.emails().map((e) => [e.kind, e.to_addr, e.reply_to]), [['order_paid', TEAM, '']]);
    assert.match(h.sent[0]!.text, /none given/);
  });

  it('a payment that verifies as failed tells the team, and only the team', async () => {
    const h = harness({ verified: (txRef, id) => ({ id: Number(id), tx_ref: txRef, status: 'successful', amount: 1, currency: 'USD', customer: { email: 'ada@example.com' } }) });
    const { order, flwId } = await startCheckout(h);
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    await h.app.request(`/pay/return?status=successful&tx_ref=${order.id}&transaction_id=${flwId}`);
    await h.flush();
    assert.deepEqual(h.emails().map((e) => [e.kind, e.to_addr, e.reply_to]), [['payment_failed', TEAM, 'ada@example.com']]);
    assert.match(h.sent[0]!.text, /amount 1 is below 149/);
    assert.match(h.sent[0]!.text, /Low priority/);
  });

  it('a cancelled checkout sends nothing', async () => {
    const h = harness();
    const { order } = await startCheckout(h);
    await h.app.request(`/pay/return?status=cancelled&tx_ref=${order.id}`);
    assert.equal(h.emails().length, 0);
  });

  it('intake submissions, intake updates and client messages reach the team with Reply-To the client', async () => {
    const h = harness();
    const { order, page } = await payOrder(h);
    await h.flush();
    h.sent.length = 0;

    assert.equal((await h.app.request(`${page}/intake`, form(VALID_INTAKE))).status, 303);
    assert.equal((await h.app.request(`${page}/intake`, form({ ...VALID_INTAKE, notes: 'Changed my mind: closed track.' }))).status, 303);
    assert.equal((await h.app.request(`${page}/message`, form({ message: 'Invited you to the repo just now.' }))).status, 303);
    await h.flush();

    assert.deepEqual(h.sent.map((m) => [m.kind, m.to, m.replyTo]), [
      ['intake', TEAM, 'ada@example.com'],
      ['intake', TEAM, 'ada@example.com'],
      ['client_message', TEAM, 'ada@example.com'],
    ]);
    assert.match(h.sent[0]!.subject, new RegExp(`Intake submitted: Pocket Ledger \\(${order.id}\\)`));
    assert.match(h.sent[0]!.text, /https:\/\/github\.com\/ada\/pocket-ledger/);
    assert.match(h.sent[1]!.subject, /Intake updated: Pocket Ledger/);
    assert.match(h.sent[1]!.text, /closed track/);
    assert.match(h.sent[2]!.text, /> Invited you to the repo just now\./);
    assert.match(h.sent[2]!.text, new RegExp(`/admin/orders/${order.id}`));
  });

  it('the admin "Send test email" button queues a message to the team and shows its status in the log', async () => {
    const h = harness();
    const admin = await login(h);
    const res = await admin.post('/admin/test-email');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin?tab=emails&flash=test-queued');
    await h.flush();
    assert.deepEqual(h.sent.map((m) => [m.kind, m.to]), [['test', TEAM]]);
    const log = await (await admin.get('/admin?tab=emails')).text();
    assert.match(log, /StoreLint test email/);
    assert.match(log, /mail-sent/);

    const off = harness({ mail: false });
    const offAdmin = await login(off);
    assert.equal((await offAdmin.post('/admin/test-email')).headers.get('location'), '/admin?tab=emails&flash=test-skipped');
    assert.match(await (await offAdmin.get('/admin?tab=emails&flash=test-skipped')).text(), /mail-skipped/);
  });
});
