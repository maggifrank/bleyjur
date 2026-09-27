import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Change, ChangeType, ExportData, Purchase, Settings } from '../shared/types.js';

export type DB = Database.Database;

export const DEFAULT_SETTINGS: Settings = {
  currency: 'ISK',
  currencySymbol: 'kr.',
  weekStart: 1,
  sizes: ['1', '2', '3', '4', '5', '6'],
  babyName: '',
};

/** Ordered migrations; index + 1 is the schema version (PRAGMA user_version). */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE changes (
    id TEXT PRIMARY KEY,
    time TEXT NOT NULL,
    time_ms INTEGER NOT NULL,
    size TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('wet','dirty','both','dry')),
    note TEXT,
    logged_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX changes_time ON changes(time_ms);

  CREATE TABLE purchases (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    date TEXT NOT NULL,
    size TEXT NOT NULL,
    brand TEXT,
    count INTEGER NOT NULL CHECK (count > 0),
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    store TEXT,
    logged_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  `,
];

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Open (and migrate) the database. Pass ':memory:' for tests. */
export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function openDataDb(dataDir: string): DB {
  return openDb(path.join(dataDir, 'bleyjur.db'));
}

interface ChangeRow {
  id: string;
  time: string;
  size: string;
  type: string;
  note: string | null;
  logged_by: string;
}

interface PurchaseRow {
  id: string;
  date: string;
  size: string;
  brand: string | null;
  count: number;
  price_minor: number;
  store: string | null;
  logged_by: string;
}

const toChange = (r: ChangeRow): Change => ({
  id: r.id,
  time: r.time,
  size: r.size,
  type: r.type as ChangeType,
  note: r.note,
  loggedBy: r.logged_by,
});

const toPurchase = (r: PurchaseRow): Purchase => ({
  id: r.id,
  date: r.date,
  size: r.size,
  brand: r.brand,
  count: r.count,
  priceMinor: r.price_minor,
  store: r.store,
  loggedBy: r.logged_by,
});

/** Thin data-access layer over the SQLite database. */
export class Store {
  constructor(readonly db: DB) {}

  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  // --- sessions ---
  createSession(token: string): void {
    this.db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').run(token, new Date().toISOString());
  }
  hasSession(token: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(token);
  }
  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // --- settings ---
  getSettings(): Settings {
    const row = this.db.prepare('SELECT json FROM settings WHERE id = 1').get() as { json: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS, sizes: [...DEFAULT_SETTINGS.sizes] };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.json) as Partial<Settings>) };
  }
  putSettings(s: Settings): Settings {
    this.db
      .prepare('INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(JSON.stringify(s));
    return this.getSettings();
  }

  // --- changes ---
  /** Sorted by time descending. */
  listChanges(): Change[] {
    const rows = this.db.prepare('SELECT * FROM changes ORDER BY time_ms DESC, id DESC').all() as ChangeRow[];
    return rows.map(toChange);
  }
  getChange(id: string): Change | undefined {
    const r = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as ChangeRow | undefined;
    return r && toChange(r);
  }
  upsertChange(c: Change): Change {
    this.db
      .prepare(
        `INSERT INTO changes (id, time, time_ms, size, type, note, logged_by, updated_at)
         VALUES (@id, @time, @timeMs, @size, @type, @note, @loggedBy, @now)
         ON CONFLICT(id) DO UPDATE SET time = excluded.time, time_ms = excluded.time_ms,
           size = excluded.size, type = excluded.type, note = excluded.note,
           logged_by = excluded.logged_by, updated_at = excluded.updated_at`,
      )
      .run({ ...c, timeMs: Date.parse(c.time), now: new Date().toISOString() });
    return this.getChange(c.id)!;
  }
  deleteChange(id: string): void {
    this.db.prepare('DELETE FROM changes WHERE id = ?').run(id);
  }

  // --- purchases ---
  /** In insertion order (used as the FIFO tie-breaker for same-date packs). */
  listPurchasesInsertionOrder(): Purchase[] {
    const rows = this.db.prepare('SELECT * FROM purchases ORDER BY seq ASC').all() as PurchaseRow[];
    return rows.map(toPurchase);
  }
  /** Sorted by date descending (newest insertion first within a date). */
  listPurchases(): Purchase[] {
    const rows = this.db.prepare('SELECT * FROM purchases ORDER BY date DESC, seq DESC').all() as PurchaseRow[];
    return rows.map(toPurchase);
  }
  getPurchase(id: string): Purchase | undefined {
    const r = this.db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRow | undefined;
    return r && toPurchase(r);
  }
  upsertPurchase(p: Purchase): Purchase {
    this.db
      .prepare(
        `INSERT INTO purchases (id, date, size, brand, count, price_minor, store, logged_by, updated_at)
         VALUES (@id, @date, @size, @brand, @count, @priceMinor, @store, @loggedBy, @now)
         ON CONFLICT(id) DO UPDATE SET date = excluded.date, size = excluded.size, brand = excluded.brand,
           count = excluded.count, price_minor = excluded.price_minor, store = excluded.store,
           logged_by = excluded.logged_by, updated_at = excluded.updated_at`,
      )
      .run({ ...p, now: new Date().toISOString() });
    return this.getPurchase(p.id)!;
  }
  deletePurchase(id: string): void {
    this.db.prepare('DELETE FROM purchases WHERE id = ?').run(id);
  }

  // --- export / import ---
  exportAll(): ExportData {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: this.getSettings(),
      // Oldest first so an import preserves insertion order.
      changes: this.listChanges().reverse(),
      purchases: this.listPurchasesInsertionOrder(),
    };
  }

  /** Replace all data (not sessions) in one transaction. Input must be validated. */
  importAll(data: ExportData): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM changes; DELETE FROM purchases; DELETE FROM settings;');
      this.putSettings(data.settings);
      for (const c of data.changes) this.upsertChange(c);
      for (const p of data.purchases) this.upsertPurchase(p);
    })();
  }
}
