import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { OrderStage } from './stages.js';

export interface ReportRow {
  id: string;
  created_at: number;
  report_json: string;
}

export interface LeadInput {
  name: string;
  email: string;
  platform: string;
  store_links: string;
  repo_url: string;
  message: string;
  ip: string;
}

export type LeadStatus = 'new' | 'contacted' | 'won' | 'lost';
export const LEAD_STATUSES: readonly LeadStatus[] = ['new', 'contacted', 'won', 'lost'];
/** `platform` value of the deep-scan waitlist signups, which share the leads table. */
export const WAITLIST_PLATFORM = 'deepscan';

export interface LeadRow extends LeadInput {
  id: number;
  created_at: number;
  status: LeadStatus;
  /** Internal notes. Never shown or sent to the lead. */
  notes: string;
  updated_at: number | null;
}

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled';
export const ORDER_STATUSES: readonly OrderStatus[] = ['pending', 'paid', 'failed', 'cancelled'];

export interface OrderInput {
  plan: string;
  amount_cents: number;
  currency: string;
  email: string;
  ip: string;
}

export interface OrderRow extends OrderInput {
  id: string;
  created_at: number;
  updated_at: number;
  /** Payment status. Delivery progress lives in `stage`. */
  status: OrderStatus;
  /** Reference sent to the payment provider. Equals `id`. */
  tx_ref: string;
  /** Provider transaction id once known. */
  flw_id: string | null;
  /** Last provider payload (verify response or error) as JSON. */
  raw_json: string | null;
  /** Delivery stage; empty until the order is paid. */
  stage: OrderStage | '';
  /** Pipeline stage the order was in before it became `needs_client` (drives the stepper while blocked). */
  stage_prev: string;
  /** Shown to the client while the stage is `needs_client`. */
  needs_client_reason: string;
  /** Unguessable secret of the client page (`/o/:id/:token`). */
  access_token: string;
  /** The client's intake answers as JSON (see src/intake-form.ts). */
  intake_json: string | null;
  intake_at: number | null;
  paid_at: number | null;
  /** Set when the team marks the order refunded outside this system; such orders leave the revenue totals. */
  refunded_at: number | null;
}

export interface OrderUpdate {
  status: OrderStatus;
  flw_id?: string | null;
  raw_json?: string | null;
  /** Only applied when the stored email is empty. */
  email?: string;
}

export type EventActor = 'admin' | 'client' | 'system';
export type EventVisibility = 'client' | 'internal';

export interface OrderEventInput {
  order_id: string;
  actor: EventActor;
  /** paid | stage | update | note | intake | message | link | email | cancelled */
  type: string;
  visibility: EventVisibility;
  body: string;
}

export interface OrderEventRow extends OrderEventInput {
  id: number;
  created_at: number;
}

export type EmailStatus = 'queued' | 'sent' | 'failed' | 'skipped';
export const EMAIL_STATUSES: readonly EmailStatus[] = ['queued', 'sent', 'failed', 'skipped'];

export interface EmailInput {
  to_addr: string;
  reply_to: string;
  subject: string;
  kind: string;
  status: EmailStatus;
  last_error: string | null;
  related_type: string | null;
  related_id: string | null;
  body_text: string;
  body_html: string;
}

export interface EmailRow extends EmailInput {
  id: number;
  created_at: number;
  attempts: number;
  sent_at: number | null;
  /** Earliest time the worker may try (again). */
  next_attempt_at: number;
}

export interface SessionRow {
  /** SHA-256 of the session id; the id itself only lives in the admin's cookie. */
  id_hash: string;
  created_at: number;
  expires_at: number;
  last_seen: number;
  ip: string;
}

export interface RevenueRow {
  currency: string;
  cents: number;
  orders: number;
}

/**
 * Tables as first shipped, plus the tables added later. Columns added after the first
 * release are NOT listed here: `migrate()` adds them with guarded ALTERs, so a fresh
 * database and the upgraded production one go through the same path and end up identical.
 */
const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  type       TEXT NOT NULL,
  visibility TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events (order_id, id);

CREATE TABLE IF NOT EXISTS emails (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  to_addr         TEXT NOT NULL,
  reply_to        TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  sent_at         INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  related_type    TEXT,
  related_id      TEXT,
  body_text       TEXT NOT NULL DEFAULT '',
  body_html       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS emails_status ON emails (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  ip         TEXT NOT NULL DEFAULT ''
);
`;

/** Columns added after the first release: [table, column, definition]. Append only. */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, ddl: string]> = [
  ['leads', 'status', "TEXT NOT NULL DEFAULT 'new'"],
  ['leads', 'notes', "TEXT NOT NULL DEFAULT ''"],
  ['leads', 'updated_at', 'INTEGER'],
  ['orders', 'stage', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'stage_prev', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'needs_client_reason', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'access_token', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'intake_json', 'TEXT'],
  ['orders', 'intake_at', 'INTEGER'],
  ['orders', 'paid_at', 'INTEGER'],
  ['orders', 'refunded_at', 'INTEGER'],
];

const POST_MIGRATION_INDEXES = `
CREATE INDEX IF NOT EXISTS orders_email ON orders (email);
CREATE INDEX IF NOT EXISTS orders_stage ON orders (status, stage);
CREATE INDEX IF NOT EXISTS leads_status ON leads (status, created_at);
`;

const OPEN_STAGES = "('intake_received','in_progress','submitted','in_review','needs_client')";

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export interface OrderFilter {
  status?: string;
  /** A stage key, or `open` for everything between intake and live. */
  stage?: string;
  /** Matches order id, email or provider reference. */
  q?: string;
  limit?: number;
}

export interface LeadFilter {
  /** true: only waitlist signups; false: only service leads; undefined: both. */
  waitlist?: boolean;
  status?: string;
  /** Matches name, email or numeric id. */
  q?: string;
  limit?: number;
}

export interface EmailFilter {
  status?: string;
  /** Matches recipient, subject or related id. */
  q?: string;
  limit?: number;
}

/** SQLite-backed storage: reports (7-day TTL), leads, orders with their timeline, the email outbox and admin sessions. */
export class Store {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.db = new Database(file);
    if (file !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.now = now;
    this.migrate();
  }

  /**
   * Idempotent, runs on every start. Creates missing tables, adds missing columns
   * (each ALTER guarded by `PRAGMA table_info`), then backfills rows written by an
   * older build. One IMMEDIATE transaction, so two processes starting together
   * (a rolling deploy on one volume) cannot both add the same column.
   */
  private migrate(): void {
    const run = this.db.transaction(() => {
      this.db.exec(SCHEMA);
      for (const [table, column, ddl] of ADDED_COLUMNS) {
        const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
        if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      }
      this.db.exec(POST_MIGRATION_INDEXES);
      this.backfill();
    });
    run.immediate();
  }

  /** Gives rows from before the upgrade (or written by an old build during a deploy) their token, stage and first event. */
  private backfill(): void {
    const tokenless = this.db.prepare("SELECT id FROM orders WHERE access_token = ''").all() as Array<{ id: string }>;
    const setToken = this.db.prepare('UPDATE orders SET access_token = ? WHERE id = ?');
    for (const { id } of tokenless) setToken.run(newAccessToken(), id);

    const unstaged = this.db.prepare("SELECT id, updated_at FROM orders WHERE status = 'paid' AND stage = ''").all() as Array<{ id: string; updated_at: number }>;
    const stage = this.db.prepare("UPDATE orders SET stage = 'paid', paid_at = COALESCE(paid_at, updated_at) WHERE id = ?");
    const hasEvents = this.db.prepare('SELECT 1 FROM order_events WHERE order_id = ? LIMIT 1');
    for (const o of unstaged) {
      stage.run(o.id);
      if (!hasEvents.get(o.id)) this.insertEvent({ order_id: o.id, actor: 'system', type: 'paid', visibility: 'client', body: 'Payment received.' }, o.updated_at);
    }
  }

  // ---- reports -------------------------------------------------------------

  insertReport(reportJson: string): ReportRow {
    const row: ReportRow = { id: newId(), created_at: this.now(), report_json: reportJson };
    this.db
      .prepare('INSERT INTO reports (id, created_at, report_json) VALUES (@id, @created_at, @report_json)')
      .run(row);
    return row;
  }

  /** Returns the report only if it was created within `ttlMs`. */
  getReport(id: string, ttlMs: number): ReportRow | undefined {
    const row = this.db.prepare('SELECT id, created_at, report_json FROM reports WHERE id = ?').get(id) as
      | ReportRow
      | undefined;
    if (!row) return undefined;
    if (this.now() - row.created_at > ttlMs) return undefined;
    return row;
  }

  deleteExpiredReports(ttlMs: number): number {
    const cutoff = this.now() - ttlMs;
    return this.db.prepare('DELETE FROM reports WHERE created_at < ?').run(cutoff).changes;
  }

  countReports(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n;
  }

  // ---- leads ---------------------------------------------------------------

  insertLead(lead: LeadInput): LeadRow {
    const created_at = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO leads (created_at, name, email, platform, store_links, repo_url, message, ip)
         VALUES (@created_at, @name, @email, @platform, @store_links, @repo_url, @message, @ip)`,
      )
      .run({ ...lead, created_at });
    return { ...lead, created_at, id: Number(result.lastInsertRowid), status: 'new', notes: '', updated_at: null };
  }

  getLead(id: number): LeadRow | undefined {
    return this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as LeadRow | undefined;
  }

  /** Every lead including waitlist signups, newest first. */
  listLeads(): LeadRow[] {
    return this.db.prepare('SELECT * FROM leads ORDER BY created_at DESC, id DESC').all() as LeadRow[];
  }

  searchLeads(f: LeadFilter = {}): LeadRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: f.limit ?? 500 };
    if (f.waitlist === true) where.push(`platform = '${WAITLIST_PLATFORM}'`);
    if (f.waitlist === false) where.push(`platform != '${WAITLIST_PLATFORM}'`);
    if (f.status) {
      where.push('status = @status');
      params.status = f.status;
    }
    if (f.q) {
      where.push("(email LIKE @q ESCAPE '\\' OR name LIKE @q ESCAPE '\\' OR CAST(id AS TEXT) = @exact)");
      params.q = likePattern(f.q);
      params.exact = f.q.replace(/^#/, '');
    }
    return this.db
      .prepare(`SELECT * FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT @limit`)
      .all(params) as LeadRow[];
  }

  updateLead(id: number, u: { status?: LeadStatus; notes?: string }): LeadRow | undefined {
    const current = this.getLead(id);
    if (!current) return undefined;
    this.db
      .prepare('UPDATE leads SET status = @status, notes = @notes, updated_at = @updated_at WHERE id = @id')
      .run({ id, status: u.status ?? current.status, notes: u.notes ?? current.notes, updated_at: this.now() });
    return this.getLead(id);
  }

  // ---- orders --------------------------------------------------------------

  insertOrder(input: OrderInput): OrderRow {
    const t = this.now();
    const id = newOrderId();
    const row: OrderRow = {
      ...input,
      id,
      created_at: t,
      updated_at: t,
      status: 'pending',
      tx_ref: id,
      flw_id: null,
      raw_json: null,
      stage: '',
      stage_prev: '',
      needs_client_reason: '',
      access_token: newAccessToken(),
      intake_json: null,
      intake_at: null,
      paid_at: null,
      refunded_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO orders (id, created_at, updated_at, plan, amount_cents, currency, email, status, tx_ref, flw_id, raw_json, ip, access_token)
         VALUES (@id, @created_at, @updated_at, @plan, @amount_cents, @currency, @email, @status, @tx_ref, @flw_id, @raw_json, @ip, @access_token)`,
      )
      .run(row);
    return row;
  }

  getOrder(id: string): OrderRow | undefined {
    return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
  }

  getOrderByTxRef(txRef: string): OrderRow | undefined {
    return this.db.prepare('SELECT * FROM orders WHERE tx_ref = ?').get(txRef) as OrderRow | undefined;
  }

  /**
   * Applies a payment-status change. A paid order never changes status again (webhook and
   * return-page races, replays), so this is safe to call repeatedly. Returns the
   * row after the call and whether the status changed. The first move to `paid`
   * also opens the delivery pipeline: stage `paid`, `paid_at`, and the first timeline event.
   */
  updateOrder(id: string, u: OrderUpdate): { row: OrderRow | undefined; changed: boolean } {
    const apply = this.db.transaction((): { row: OrderRow | undefined; changed: boolean } => {
      const current = this.getOrder(id);
      if (!current) return { row: undefined, changed: false };
      if (current.status === 'paid' && u.status !== 'paid') return { row: current, changed: false };
      const sameStatus = current.status === u.status;
      const flw_id = u.flw_id === undefined ? current.flw_id : u.flw_id;
      const raw_json = u.raw_json === undefined ? current.raw_json : u.raw_json;
      const email = current.email || u.email || '';
      if (sameStatus && flw_id === current.flw_id && raw_json === current.raw_json && email === current.email) {
        return { row: current, changed: false };
      }
      const t = this.now();
      const becamePaid = !sameStatus && u.status === 'paid';
      this.db
        .prepare(
          `UPDATE orders SET status = @status, flw_id = @flw_id, raw_json = @raw_json, email = @email, updated_at = @updated_at,
             stage = @stage, paid_at = @paid_at, access_token = @access_token WHERE id = @id`,
        )
        .run({
          id,
          status: u.status,
          flw_id,
          raw_json,
          email,
          updated_at: t,
          stage: becamePaid && !current.stage ? 'paid' : current.stage,
          paid_at: becamePaid ? t : current.paid_at,
          access_token: current.access_token || newAccessToken(),
        });
      if (becamePaid) this.insertEvent({ order_id: id, actor: 'system', type: 'paid', visibility: 'client', body: 'Payment received.' }, t);
      return { row: this.getOrder(id), changed: !sameStatus };
    });
    return apply.immediate();
  }

  /** Every order, newest first. */
  listOrders(): OrderRow[] {
    return this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all() as OrderRow[];
  }

  searchOrders(f: OrderFilter = {}): OrderRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: f.limit ?? 500 };
    if (f.status) {
      where.push('status = @status');
      params.status = f.status;
    }
    if (f.stage === 'open') where.push(`status = 'paid' AND stage IN ${OPEN_STAGES}`);
    else if (f.stage) {
      where.push('stage = @stage');
      params.stage = f.stage;
    }
    if (f.q) {
      where.push("(id LIKE @q ESCAPE '\\' OR email LIKE @q ESCAPE '\\' OR flw_id LIKE @q ESCAPE '\\')");
      params.q = likePattern(f.q);
    }
    return this.db
      .prepare(`SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT @limit`)
      .all(params) as OrderRow[];
  }

  /** Paid orders whose email equals `email` (case-insensitive), newest first. */
  findPaidOrdersByEmail(email: string): OrderRow[] {
    return this.db
      .prepare("SELECT * FROM orders WHERE status = 'paid' AND email != '' AND lower(email) = lower(?) ORDER BY created_at DESC, id DESC LIMIT 20")
      .all(email) as OrderRow[];
  }

  /**
   * Moves a paid order to `stage`. Entering `needs_client` remembers where the order was
   * (for the stepper) and stores the reason; leaving it clears the reason.
   */
  setOrderStage(id: string, stage: OrderStage, reason = ''): OrderRow | undefined {
    const current = this.getOrder(id);
    if (!current) return undefined;
    const blocked = stage === 'needs_client';
    const stage_prev = blocked ? (current.stage === 'needs_client' ? current.stage_prev : current.stage) : '';
    this.db
      .prepare('UPDATE orders SET stage = @stage, stage_prev = @stage_prev, needs_client_reason = @reason, updated_at = @updated_at WHERE id = @id')
      .run({ id, stage, stage_prev, reason: blocked ? reason : '', updated_at: this.now() });
    return this.getOrder(id);
  }

  saveIntake(id: string, intakeJson: string): OrderRow | undefined {
    const t = this.now();
    this.db.prepare('UPDATE orders SET intake_json = ?, intake_at = ?, updated_at = ? WHERE id = ?').run(intakeJson, t, t, id);
    return this.getOrder(id);
  }

  setOrderEmail(id: string, email: string): OrderRow | undefined {
    this.db.prepare('UPDATE orders SET email = ?, updated_at = ? WHERE id = ?').run(email, this.now(), id);
    return this.getOrder(id);
  }

  markOrderRefunded(id: string): OrderRow | undefined {
    const t = this.now();
    this.db.prepare('UPDATE orders SET refunded_at = COALESCE(refunded_at, ?), updated_at = ? WHERE id = ?').run(t, t, id);
    return this.getOrder(id);
  }

  // ---- order timeline ------------------------------------------------------

  private insertEvent(e: OrderEventInput, at: number): OrderEventRow {
    const result = this.db
      .prepare('INSERT INTO order_events (order_id, created_at, actor, type, visibility, body) VALUES (@order_id, @created_at, @actor, @type, @visibility, @body)')
      .run({ ...e, created_at: at });
    return { ...e, id: Number(result.lastInsertRowid), created_at: at };
  }

  addOrderEvent(e: OrderEventInput): OrderEventRow {
    return this.insertEvent(e, this.now());
  }

  /** Oldest first. Pass `'client'` to get only what the client may see. */
  listOrderEvents(orderId: string, visibility?: EventVisibility): OrderEventRow[] {
    return (
      visibility
        ? this.db.prepare('SELECT * FROM order_events WHERE order_id = ? AND visibility = ? ORDER BY id').all(orderId, visibility)
        : this.db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(orderId)
    ) as OrderEventRow[];
  }

  countOrderEvents(orderId: string, actor: EventActor, type: string, since: number): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND actor = ? AND type = ? AND created_at > ?').get(orderId, actor, type, since) as { n: number }
    ).n;
  }

  // ---- dashboard -----------------------------------------------------------

  dashboardCounts(): { newLeads: number; awaitingIntake: number; inProgress: number; waitlist: number; live: number; orders: number; leads: number; emails: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      newLeads: n(`SELECT COUNT(*) AS n FROM leads WHERE status = 'new' AND platform != '${WAITLIST_PLATFORM}'`),
      awaitingIntake: n("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND stage = 'paid'"),
      inProgress: n(`SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND stage IN ${OPEN_STAGES}`),
      waitlist: n(`SELECT COUNT(*) AS n FROM leads WHERE platform = '${WAITLIST_PLATFORM}'`),
      live: n("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND stage = 'live'"),
      orders: n('SELECT COUNT(*) AS n FROM orders'),
      leads: n(`SELECT COUNT(*) AS n FROM leads WHERE platform != '${WAITLIST_PLATFORM}'`),
      emails: n('SELECT COUNT(*) AS n FROM emails'),
    };
  }

  /** Paid, not refunded, grouped by currency. `since` limits to orders paid at or after that time. */
  revenue(since?: number): RevenueRow[] {
    return this.db
      .prepare(
        `SELECT currency, SUM(amount_cents) AS cents, COUNT(*) AS orders FROM orders
         WHERE status = 'paid' AND refunded_at IS NULL AND COALESCE(paid_at, updated_at) >= ?
         GROUP BY currency ORDER BY cents DESC`,
      )
      .all(since ?? 0) as RevenueRow[];
  }

  /** Paid orders still waiting for the intake `olderThanMs` after payment. */
  ordersAwaitingIntake(olderThanMs: number): OrderRow[] {
    return this.db
      .prepare("SELECT * FROM orders WHERE status = 'paid' AND stage = 'paid' AND COALESCE(paid_at, updated_at) < ? ORDER BY paid_at")
      .all(this.now() - olderThanMs) as OrderRow[];
  }

  /** Service leads (not the waitlist) still `new` after `olderThanMs`. */
  leadsAwaitingReply(olderThanMs: number): LeadRow[] {
    return this.db
      .prepare(`SELECT * FROM leads WHERE status = 'new' AND platform != '${WAITLIST_PLATFORM}' AND created_at < ? ORDER BY created_at`)
      .all(this.now() - olderThanMs) as LeadRow[];
  }

  /** Orders whose latest client message has no client-visible reply from the team after it. */
  ordersAwaitingReply(): Array<OrderRow & { last_message_at: number }> {
    return this.db
      .prepare(
        `SELECT o.*, m.last_message_at FROM orders o
         JOIN (SELECT order_id, MAX(id) AS last_id, MAX(created_at) AS last_message_at FROM order_events
               WHERE actor = 'client' AND type = 'message' GROUP BY order_id) m ON m.order_id = o.id
         WHERE NOT EXISTS (SELECT 1 FROM order_events a WHERE a.order_id = o.id AND a.actor = 'admin' AND a.visibility = 'client' AND a.id > m.last_id)
         ORDER BY m.last_message_at`,
      )
      .all() as Array<OrderRow & { last_message_at: number }>;
  }

  // ---- email outbox --------------------------------------------------------

  insertEmail(e: EmailInput): EmailRow {
    const created_at = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO emails (created_at, to_addr, reply_to, subject, kind, status, last_error, next_attempt_at, related_type, related_id, body_text, body_html)
         VALUES (@created_at, @to_addr, @reply_to, @subject, @kind, @status, @last_error, @created_at, @related_type, @related_id, @body_text, @body_html)`,
      )
      .run({ ...e, created_at });
    return { ...e, id: Number(result.lastInsertRowid), created_at, attempts: 0, sent_at: null, next_attempt_at: created_at };
  }

  getEmail(id: number): EmailRow | undefined {
    return this.db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as EmailRow | undefined;
  }

  listEmails(f: EmailFilter = {}): EmailRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: f.limit ?? 200 };
    if (f.status) {
      where.push('status = @status');
      params.status = f.status;
    }
    if (f.q) {
      where.push("(to_addr LIKE @q ESCAPE '\\' OR subject LIKE @q ESCAPE '\\' OR related_id LIKE @q ESCAPE '\\')");
      params.q = likePattern(f.q);
    }
    return this.db.prepare(`SELECT * FROM emails ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT @limit`).all(params) as EmailRow[];
  }

  /** Queued mail whose next attempt is due, oldest first. */
  dueEmails(limit = 20): EmailRow[] {
    return this.db.prepare("SELECT * FROM emails WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT ?").all(this.now(), limit) as EmailRow[];
  }

  markEmailSent(id: number): void {
    this.db.prepare("UPDATE emails SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?").run(this.now(), id);
  }

  /** Records a failed attempt. `retryAt` undefined means give up (`failed`). */
  markEmailAttemptFailed(id: number, error: string, retryAt: number | undefined): void {
    this.db
      .prepare('UPDATE emails SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?')
      .run(retryAt === undefined ? 'failed' : 'queued', error.slice(0, 1000), retryAt ?? 0, id);
  }

  markEmailSkipped(id: number, reason: string): void {
    this.db.prepare("UPDATE emails SET status = 'skipped', last_error = ? WHERE id = ?").run(reason, id);
  }

  /** Puts a failed or skipped message back in the queue with a fresh retry budget. */
  requeueEmail(id: number): EmailRow | undefined {
    this.db.prepare("UPDATE emails SET status = 'queued', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ? AND status IN ('failed', 'skipped')").run(this.now(), id);
    return this.getEmail(id);
  }

  countEmails(status: EmailStatus): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM emails WHERE status = ?').get(status) as { n: number }).n;
  }

  /** True when a message of `kind` was recorded for `to` after `since` (used to throttle repeat mail). */
  hasRecentEmail(kind: string, to: string, since: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM emails WHERE kind = ? AND lower(to_addr) = lower(?) AND created_at > ? LIMIT 1').get(kind, to, since));
  }

  // ---- admin sessions ------------------------------------------------------

  insertSession(idHash: string, expiresAt: number, ip: string): void {
    const t = this.now();
    this.db.prepare('INSERT INTO sessions (id_hash, created_at, expires_at, last_seen, ip) VALUES (?, ?, ?, ?, ?)').run(idHash, t, expiresAt, t, ip);
  }

  /** Returns the session only while it has not expired. */
  getSession(idHash: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
    return row && row.expires_at > this.now() ? row : undefined;
  }

  extendSession(idHash: string, expiresAt: number): void {
    this.db.prepare('UPDATE sessions SET expires_at = ?, last_seen = ? WHERE id_hash = ?').run(expiresAt, this.now(), idHash);
  }

  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteExpiredSessions(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now()).changes;
  }

  close(): void {
    this.db.close();
  }
}

function newId(): string {
  return randomBytes(9).toString('base64url');
}

/** Order ids double as the provider tx_ref, so keep them to [A-Za-z0-9_]. */
function newOrderId(): string {
  return `sl_${randomBytes(8).toString('hex')}`;
}

/** 32 random bytes, base64url (43 characters). */
function newAccessToken(): string {
  return randomBytes(32).toString('base64url');
}
