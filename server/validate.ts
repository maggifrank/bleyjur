// Request body validation. Each validator returns the normalized value or
// throws a ValidationError (mapped to 400 {error}).
import { DateTime } from 'luxon';
import { CHANGE_TYPES } from '../shared/types.js';
import type { Change, ChangeType, ExportData, Purchase, Settings } from '../shared/types.js';

export class ValidationError extends Error {
  readonly statusCode = 400;
}

type Obj = Record<string, unknown>;

function fail(msg: string): never {
  throw new ValidationError(msg);
}

function obj(v: unknown, what: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${what} must be an object`);
  return v as Obj;
}

function str(o: Obj, key: string, { nonEmpty = false, max = 1000 } = {}): string {
  const v = o[key];
  if (typeof v !== 'string') fail(`${key} must be a string`);
  if (nonEmpty && v.trim() === '') fail(`${key} must not be empty`);
  if (v.length > max) fail(`${key} is too long`);
  return v;
}

function optStr(o: Obj, key: string, max = 1000): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(`${key} must be a string or null`);
  if (v.length > max) fail(`${key} is too long`);
  return v;
}

function id(o: Obj): string {
  return str(o, 'id', { nonEmpty: true, max: 100 });
}

export function validateChange(body: unknown, expectedId?: string): Change {
  const o = obj(body, 'change');
  const cid = id(o);
  if (expectedId !== undefined && cid !== expectedId) fail('id must match the URL');
  const timeRaw = str(o, 'time', { nonEmpty: true, max: 64 });
  const dt = DateTime.fromISO(timeRaw, { setZone: true });
  if (!timeRaw.includes('T') || !dt.isValid) fail('time must be an ISO 8601 date-time');
  const type = o.type;
  if (typeof type !== 'string' || !CHANGE_TYPES.includes(type as ChangeType)) {
    fail(`type must be one of ${CHANGE_TYPES.join(', ')}`);
  }
  return {
    id: cid,
    time: dt.toUTC().toISO()!,
    size: str(o, 'size', { nonEmpty: true, max: 50 }),
    type: type as ChangeType,
    note: optStr(o, 'note', 2000),
    loggedBy: str(o, 'loggedBy', { max: 100 }),
  };
}

export function validatePurchase(body: unknown, expectedId?: string): Purchase {
  const o = obj(body, 'purchase');
  const pid = id(o);
  if (expectedId !== undefined && pid !== expectedId) fail('id must match the URL');
  const date = str(o, 'date', { nonEmpty: true, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !DateTime.fromISO(date).isValid) fail('date must be YYYY-MM-DD');
  const count = o.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) fail('count must be a positive integer');
  const priceMinor = o.priceMinor;
  if (typeof priceMinor !== 'number' || !Number.isSafeInteger(priceMinor) || priceMinor < 0) {
    fail('priceMinor must be a non-negative integer');
  }
  return {
    id: pid,
    date,
    size: str(o, 'size', { nonEmpty: true, max: 50 }),
    brand: optStr(o, 'brand', 200),
    count,
    priceMinor,
    store: optStr(o, 'store', 200),
    loggedBy: str(o, 'loggedBy', { max: 100 }),
  };
}

export function validateSettings(body: unknown): Settings {
  const o = obj(body, 'settings');
  const weekStart = o.weekStart;
  if (typeof weekStart !== 'number' || !Number.isInteger(weekStart) || weekStart < 1 || weekStart > 7) {
    fail('weekStart must be an integer 1..7');
  }
  const sizes = o.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) fail('sizes must be a non-empty array');
  if (sizes.some((s) => typeof s !== 'string' || s.trim() === '' || s.length > 50)) {
    fail('sizes must be non-empty strings');
  }
  if (new Set(sizes).size !== sizes.length) fail('sizes must be unique');
  return {
    currency: str(o, 'currency', { nonEmpty: true, max: 10 }),
    currencySymbol: str(o, 'currencySymbol', { max: 10 }),
    weekStart,
    sizes: sizes as string[],
    babyName: str(o, 'babyName', { max: 100 }),
  };
}

export function validateExport(body: unknown): ExportData {
  const o = obj(body, 'import');
  if (o.version !== 1) fail('version must be 1');
  if (!Array.isArray(o.changes)) fail('changes must be an array');
  if (!Array.isArray(o.purchases)) fail('purchases must be an array');
  const wrap = <T>(i: number, what: string, f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof ValidationError) fail(`${what}[${i}]: ${e.message}`);
      throw e;
    }
  };
  const changes = o.changes.map((c, i) => wrap(i, 'changes', () => validateChange(c)));
  const purchases = o.purchases.map((p, i) => wrap(i, 'purchases', () => validatePurchase(p)));
  if (new Set(changes.map((c) => c.id)).size !== changes.length) fail('duplicate change ids');
  if (new Set(purchases.map((p) => p.id)).size !== purchases.length) fail('duplicate purchase ids');
  return {
    version: 1,
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : new Date().toISOString(),
    settings: validateSettings(o.settings),
    changes,
    purchases,
  };
}
