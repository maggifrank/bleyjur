// Small helpers: UUIDs, localStorage JSON, dates and money formatting.
import type { Settings } from '../../shared/types';

/** RFC 4122 v4 UUID. crypto.randomUUID only exists in secure contexts (not plain http on LAN). */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* fall through */
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: ignore */
  }
}

export function readString(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date YYYY-MM-DD for a Date. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Value for <input type="datetime-local"> from an ISO instant. */
export function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse an <input type="datetime-local"> value (local time) into an ISO instant. */
export function fromDateTimeLocal(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MONTHS_IS = ['jan.', 'feb.', 'mar.', 'apr.', 'maí', 'jún.', 'júl.', 'ágú.', 'sep.', 'okt.', 'nóv.', 'des.'];

export function fmtDate(isoDate: string, lang: string): string {
  // isoDate is YYYY-MM-DD (local calendar date); build it as a local date.
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  const showYear = date.getFullYear() !== new Date().getFullYear();
  if (lang === 'is') {
    // Built by hand: some browsers lack is-IS locale data and fall back to English.
    return `${date.getDate()}. ${MONTHS_IS[date.getMonth()]}${showYear ? ` ${date.getFullYear()}` : ''}`;
  }
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: showYear ? 'numeric' : undefined,
  }).format(date);
}

/** Currencies that are shown without decimals. */
const ZERO_DECIMAL = new Set(['ISK', 'JPY', 'KRW', 'HUF', 'CLP']);

/**
 * Icelandic number format ("1.234,5"), done by hand because some browsers
 * ship without the is-IS locale data and silently fall back to "1,234.5".
 */
export function numberFmt(n: number, decimals: number): string {
  const [int, frac] = Math.abs(n).toFixed(decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = n < 0 && Number(`${int}.${frac ?? 0}`) !== 0 ? '-' : '';
  return sign + grouped + (frac ? `,${frac}` : '');
}

/** Format an amount in minor units (1/100) for display: "1.000 kr.". */
export function fmtMoney(minor: number, settings: Pick<Settings, 'currency' | 'currencySymbol'>): string {
  const decimals = ZERO_DECIMAL.has(settings.currency.toUpperCase()) ? 0 : 2;
  const major = minor / 100;
  const sym = settings.currencySymbol || settings.currency;
  return `${numberFmt(major, decimals)} ${sym}`;
}

export function fmtNumber(n: number, maxDecimals = 1): string {
  // Drop trailing fraction zeros: "0,30" -> "0,3", "2,0" -> "2".
  return numberFmt(n, maxDecimals).replace(/(,\d*?)0+$/, '$1').replace(/,$/, '');
}

/**
 * Parse a user-entered price in major units ("899", "1.299", "1 299", "12,50")
 * into minor units. Returns null if invalid.
 */
export function parseMoneyToMinor(input: string): number | null {
  let s = input.trim().replace(/[\s ]/g, '');
  if (!s) return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  if (!isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}

/** Inverse of parseMoneyToMinor for pre-filling edit forms. */
export function minorToInput(minor: number): string {
  const major = minor / 100;
  return Number.isInteger(major) ? String(major) : major.toFixed(2).replace('.', ',');
}
