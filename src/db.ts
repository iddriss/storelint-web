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
`;

/** SQLite-backed storage for reports (7-day TTL) and service leads. */
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
