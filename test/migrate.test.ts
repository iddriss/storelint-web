import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { stubScan } from '../src/scanner.js';

/** The schema exactly as the first production release created it (before stages, tokens, events, emails, sessions). */
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  report_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_created_at ON reports (created_at);

CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  platform    TEXT NOT NULL,
  store_links TEXT NOT NULL DEFAULT '',
  repo_url    TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  plan         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  email        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  tx_ref       TEXT NOT NULL UNIQUE,
  flw_id       TEXT,
  raw_json     TEXT,
  ip           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS orders_created_at ON orders (created_at);
`;

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const dirs: string[] = [];

function v1Database(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'storelint-migrate-'));
  dirs.push(dir);
  const file = path.join(dir, 'storelint.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(V1_SCHEMA);
  db.prepare('INSERT INTO reports (id, created_at, report_json) VALUES (?, ?, ?)').run('rep_1', T0, '{"schemaVersion":1}');
  db.prepare('INSERT INTO leads (created_at, name, email, platform, message, ip) VALUES (?, ?, ?, ?, ?, ?)').run(T0, 'Ada Lovelace', 'ada@example.com', 'both', 'Old lead', '203.0.113.9');
  db.prepare('INSERT INTO leads (created_at, name, email, platform) VALUES (?, ?, ?, ?)').run(T0 + 1, '(deep scan waitlist)', 'w@example.com', 'deepscan');
  const order = db.prepare('INSERT INTO orders (id, created_at, updated_at, plan, amount_cents, currency, email, status, tx_ref, flw_id, raw_json, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  order.run('sl_aaaaaaaaaaaaaaaa', T0, T0 + 5000, 'both', 29900, 'USD', 'ada@example.com', 'paid', 'sl_aaaaaaaaaaaaaaaa', '900001', '{"status":"successful"}', '203.0.113.9');
  order.run('sl_bbbbbbbbbbbbbbbb', T0 + 10, T0 + 10, 'play', 14900, 'USD', '', 'pending', 'sl_bbbbbbbbbbbbbbbb', null, null, '');
  order.run('sl_cccccccccccccccc', T0 + 20, T0 + 30, 'fix', 9900, 'USD', 'bob@example.com', 'failed', 'sl_cccccccccccccccc', '900002', null, '');
  db.close();
  return file;
}

const columns = (file: string, table: string): string[] => {
  const db = new Database(file, { readonly: true });
  const names = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
  db.close();
  return names;
};

describe('database migration', () => {
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades a database created with the first schema in place, keeping every row', () => {
    const file = v1Database();
    assert.ok(!columns(file, 'orders').includes('stage'));
    const now = T0 + 86_400_000;
    const store = new Store(file, () => now);

    for (const column of ['stage', 'stage_prev', 'needs_client_reason', 'access_token', 'intake_json', 'intake_at', 'paid_at', 'refunded_at']) {
      assert.ok(columns(file, 'orders').includes(column), `orders.${column}`);
    }
    for (const column of ['status', 'notes', 'updated_at']) assert.ok(columns(file, 'leads').includes(column), `leads.${column}`);
    assert.deepEqual(columns(file, 'order_events'), ['id', 'order_id', 'created_at', 'actor', 'type', 'visibility', 'body']);
    for (const column of ['id', 'created_at', 'to_addr', 'subject', 'kind', 'status', 'attempts', 'last_error', 'sent_at', 'related_type', 'related_id', 'body_text', 'body_html']) {
      assert.ok(columns(file, 'emails').includes(column), `emails.${column}`);
    }
    assert.ok(columns(file, 'sessions').includes('id_hash'));

    // Existing rows survive with sensible defaults.
    assert.equal(store.countReports(), 1);
    const leads = store.listLeads();
    assert.equal(leads.length, 2);
    assert.deepEqual(leads.map((l) => [l.name, l.status, l.notes]), [['(deep scan waitlist)', 'new', ''], ['Ada Lovelace', 'new', '']]);

    const paid = store.getOrder('sl_aaaaaaaaaaaaaaaa')!;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.stage, 'paid');
    assert.equal(paid.paid_at, T0 + 5000, 'paid_at falls back to the last update of the old row');
    assert.equal(paid.email, 'ada@example.com');
    assert.equal(paid.flw_id, '900001');
    assert.equal(paid.raw_json, '{"status":"successful"}');
    assert.equal(paid.intake_json, null);
    assert.equal(paid.refunded_at, null);
    assert.deepEqual(store.listOrderEvents(paid.id).map((e) => [e.actor, e.type, e.visibility, e.body, e.created_at]), [['system', 'paid', 'client', 'Payment received.', T0 + 5000]]);

    const pending = store.getOrder('sl_bbbbbbbbbbbbbbbb')!;
    const failed = store.getOrder('sl_cccccccccccccccc')!;
    assert.deepEqual([pending.status, pending.stage, pending.paid_at], ['pending', '', null]);
    assert.deepEqual([failed.status, failed.stage, failed.paid_at], ['failed', '', null]);
    assert.equal(store.listOrderEvents(pending.id).length, 0);

    const tokens = [paid, pending, failed].map((o) => o.access_token);
    for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
    assert.equal(new Set(tokens).size, 3);

    assert.deepEqual(store.revenue(), [{ currency: 'USD', cents: 29900, orders: 1 }]);
    assert.equal(store.ordersAwaitingIntake(3_600_000).length, 1, 'the old paid order shows up as waiting for its intake');
    assert.equal(store.leadsAwaitingReply(3_600_000).length, 1);
    store.close();
  });

  it('is idempotent: reopening changes nothing and keeps the tokens', () => {
    const file = v1Database();
    const first = new Store(file);
    const before = first.listOrders().map((o) => ({ ...o }));
    first.setOrderStage('sl_aaaaaaaaaaaaaaaa', 'in_progress');
    first.addOrderEvent({ order_id: 'sl_aaaaaaaaaaaaaaaa', actor: 'admin', type: 'note', visibility: 'internal', body: 'keep me' });
    first.close();

    for (let i = 0; i < 3; i++) new Store(file).close();
    const again = new Store(file);
    assert.deepEqual(again.listOrders().map((o) => o.access_token), before.map((o) => o.access_token));
    assert.equal(again.getOrder('sl_aaaaaaaaaaaaaaaa')?.stage, 'in_progress', 'a stage set after the upgrade is not reset');
    assert.deepEqual(again.listOrderEvents('sl_aaaaaaaaaaaaaaaa').map((e) => e.type), ['paid', 'note'], 'no duplicate payment event');
    assert.equal(again.listLeads().length, 2);
    again.close();
  });

  it('repairs rows written by an old build after the upgrade (rolling deploy)', () => {
    const file = v1Database();
    new Store(file).close();
    // The previous container is still running against the upgraded file and inserts with its own column list.
    const old = new Database(file);
    old.prepare("INSERT INTO orders (id, created_at, updated_at, plan, amount_cents, currency, email, status, tx_ref, flw_id, raw_json, ip) VALUES ('sl_dddddddddddddddd', ?, ?, 'ios', 19900, 'USD', 'eve@example.com', 'paid', 'sl_dddddddddddddddd', '900003', NULL, '')").run(T0 + 100, T0 + 200);
    old.close();
    const store = new Store(file);
    const late = store.getOrder('sl_dddddddddddddddd')!;
    assert.match(late.access_token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(late.stage, 'paid');
    assert.equal(late.paid_at, T0 + 200);
    assert.equal(store.listOrderEvents(late.id).length, 1);
    store.close();
  });

  it('the upgraded database serves the client page and the admin for an order paid before the upgrade', async () => {
    const file = v1Database();
    const store = new Store(file);
    const config = loadConfig({ ADMIN_PASSWORD: 'pw-for-migration-test', ADMIN_TOKEN: 'adm1n', PUBLIC_URL: 'https://storelint.example' });
    const app = createApp({ store, config, scanner: { scan: stubScan, available: false, source: 'stub' } });
    const order = store.getOrder('sl_aaaaaaaaaaaaaaaa')!;
    const page = await app.request(`/o/${order.id}/${order.access_token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Both stores/);
    assert.match(html, /Payment received\. We need the intake to start\./);
    const api = await app.request('/admin/api/orders', { headers: { authorization: 'Bearer adm1n' } });
    assert.equal(((await api.json()) as { count: number }).count, 3);
    store.close();
  });

  it('a fresh database gets the same columns as an upgraded one', () => {
    const upgraded = v1Database();
    new Store(upgraded).close();
    const dir = mkdtempSync(path.join(tmpdir(), 'storelint-migrate-'));
    dirs.push(dir);
    const fresh = path.join(dir, 'fresh.db');
    new Store(fresh).close();
    for (const table of ['reports', 'leads', 'orders', 'order_events', 'emails', 'sessions']) {
      assert.deepEqual(columns(fresh, table), columns(upgraded, table), table);
    }
  });
});
