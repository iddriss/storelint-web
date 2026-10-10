import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

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

export interface LeadRow extends LeadInput {
  id: number;
  created_at: number;
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
  status: OrderStatus;
  /** Reference sent to the payment provider. Equals `id`. */
  tx_ref: string;
  /** Provider transaction id once known. */
  flw_id: string | null;
  /** Last provider payload (verify response or error) as JSON. */
  raw_json: string | null;
}

export interface OrderUpdate {
  status: OrderStatus;
  flw_id?: string | null;
  raw_json?: string | null;
  /** Only applied when the stored email is empty. */
  email?: string;
}

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
`;

/** SQLite-backed storage for reports (7-day TTL), service leads and payment orders. */
export class Store {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.db = new Database(file);
    if (file !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.now = now;
  }

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

  insertLead(lead: LeadInput): LeadRow {
    const created_at = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO leads (created_at, name, email, platform, store_links, repo_url, message, ip)
         VALUES (@created_at, @name, @email, @platform, @store_links, @repo_url, @message, @ip)`,
      )
      .run({ ...lead, created_at });
    return { ...lead, created_at, id: Number(result.lastInsertRowid) };
  }

  listLeads(): LeadRow[] {
    return this.db.prepare('SELECT * FROM leads ORDER BY created_at DESC, id DESC').all() as LeadRow[];
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
    };
    this.db
      .prepare(
        `INSERT INTO orders (id, created_at, updated_at, plan, amount_cents, currency, email, status, tx_ref, flw_id, raw_json, ip)
         VALUES (@id, @created_at, @updated_at, @plan, @amount_cents, @currency, @email, @status, @tx_ref, @flw_id, @raw_json, @ip)`,
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
   * Applies a status change. A paid order never changes status again (webhook and
   * return-page races, replays), so this is safe to call repeatedly. Returns the
   * row after the call and whether anything changed.
   */
  updateOrder(id: string, u: OrderUpdate): { row: OrderRow | undefined; changed: boolean } {
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
    this.db
      .prepare('UPDATE orders SET status = @status, flw_id = @flw_id, raw_json = @raw_json, email = @email, updated_at = @updated_at WHERE id = @id')
      .run({ id, status: u.status, flw_id, raw_json, email, updated_at: this.now() });
    return { row: this.getOrder(id), changed: !sameStatus };
  }

  listOrders(): OrderRow[] {
    return this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC').all() as OrderRow[];
  }

  countReports(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n;
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
