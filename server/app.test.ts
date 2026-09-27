import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppState, Change, ExportData, Purchase, ReportsResponse } from '../shared/types.js';
import { buildApp, SESSION_COOKIE } from './app.js';
import { openDb, type DB } from './db.js';

const PIN = '4321';

let db: DB;
let app: FastifyInstance;
let clock: number;

beforeEach(async () => {
  db = openDb(':memory:');
  clock = Date.parse('2026-09-26T12:00:00Z');
  app = await buildApp({ db, pin: PIN, now: () => clock });
});

afterEach(async () => {
  await app.close();
  db.close();
});

async function login(ip = '127.0.0.1'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { pin: PIN }, remoteAddress: ip });
  expect(res.statusCode).toBe(200);
  const c = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
  return `${SESSION_COOKIE}=${c.value}`;
}

const change = (id: string, extra: Partial<Change> = {}): Change => ({
  id,
  time: '2026-09-26T08:15:00.000Z',
  size: '3',
  type: 'wet',
  note: null,
  loggedBy: 'Mamma',
  ...extra,
});
const purchase = (id: string, extra: Partial<Purchase> = {}): Purchase => ({
  id,
  date: '2026-09-20',
  size: '3',
  brand: 'Libero',
  count: 20,
  priceMinor: 100000,
  store: null,
  loggedBy: 'Pabbi',
  ...extra,
});

describe('auth', () => {
  it('health needs no auth', async () => {
    const res = await app.inject('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('401 without cookie', async () => {
    for (const url of ['/api/state', '/api/reports', '/api/export']) {
      const res = await app.inject(url);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    }
    const put = await app.inject({ method: 'PUT', url: '/api/changes/a', payload: change('a') });
    expect(put.statusCode).toBe(401);
    const bogus = await app.inject({ url: '/api/state', headers: { cookie: `${SESSION_COOKIE}=nope` } });
    expect(bogus.statusCode).toBe(401);
  });

  it('login flow: session, cookie attributes, logout', async () => {
    expect((await app.inject('/api/session')).json()).toEqual({ authed: false });

    const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { pin: '0000' } });
    expect(bad.statusCode).toBe(401);

    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { pin: PIN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=31536000/);
    expect(setCookie).not.toMatch(/Secure/i);

    const cookie = `${SESSION_COOKIE}=${res.cookies[0].value}`;
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({ authed: true });
    expect((await app.inject({ url: '/api/state', headers: { cookie } })).statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(out.json()).toEqual({ ok: true });
    expect((await app.inject({ url: '/api/state', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rate limits wrong PINs per IP with escalating lockout', async () => {
    const attempt = (pin: string, ip = '10.0.0.1') =>
      app.inject({ method: 'POST', url: '/api/login', payload: { pin }, remoteAddress: ip });

    for (let i = 0; i < 5; i++) expect((await attempt('0000')).statusCode).toBe(401);

    const locked = await attempt(PIN); // even the right PIN is refused while locked
    expect(locked.statusCode).toBe(429);
    expect(locked.json().retryAfter).toBe(30);
    expect(locked.headers['retry-after']).toBe('30');

    // Another IP is unaffected.
    expect((await attempt(PIN, '10.0.0.2')).statusCode).toBe(200);

    clock += 31_000;
    expect((await attempt('0000')).statusCode).toBe(401); // 6th failure: 60s lock
    expect((await attempt(PIN)).json().retryAfter).toBe(60);

    clock += 61_000;
    expect((await attempt(PIN)).statusCode).toBe(200); // success resets
    expect((await attempt('0000')).statusCode).toBe(401);
    expect((await attempt('0000')).statusCode).toBe(401);
  });

  it('lockout caps at 15 minutes', async () => {
    const attempt = (pin: string) =>
      app.inject({ method: 'POST', url: '/api/login', payload: { pin }, remoteAddress: '10.9.9.9' });
    for (let i = 0; i < 20; i++) {
      await attempt('0000');
      clock += 16 * 60_000;
    }
    await attempt('0000');
    expect((await attempt(PIN)).json().retryAfter).toBe(900);
  });

  it('400 on missing pin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('data API', () => {
  let cookie: string;
  beforeEach(async () => {
    cookie = await login();
  });
  const req = (method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, payload: payload as object });

  it('change upsert is idempotent', async () => {
    const c = change('11111111-1111-4111-8111-111111111111');
    const r1 = await req('PUT', `/api/changes/${c.id}`, c);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual(c);
    const r2 = await req('PUT', `/api/changes/${c.id}`, c);
    expect(r2.json()).toEqual(c);
    let state = (await req('GET', '/api/state')).json() as AppState;
    expect(state.changes).toHaveLength(1);

    // Editing via the same id updates in place.
    await req('PUT', `/api/changes/${c.id}`, { ...c, type: 'dry', note: 'hi' });
    state = (await req('GET', '/api/state')).json() as AppState;
    expect(state.changes).toEqual([{ ...c, type: 'dry', note: 'hi' }]);
  });

  it('normalizes change time to UTC ISO', async () => {
    const r = await req('PUT', '/api/changes/t', change('t', { time: '2026-09-26T10:15:00+02:00' }));
    expect(r.json().time).toBe('2026-09-26T08:15:00.000Z');
  });

  it('validates bodies', async () => {
    const bad: [string, unknown][] = [
      ['/api/changes/x', change('y')],
      ['/api/changes/x', change('x', { type: 'soggy' as never })],
      ['/api/changes/x', change('x', { size: '' })],
      ['/api/changes/x', change('x', { time: 'yesterday' })],
      ['/api/changes/x', change('x', { time: '2026-09-26' })],
      ['/api/changes/x', ['nope']],
      ['/api/purchases/x', purchase('x', { count: 0 })],
      ['/api/purchases/x', purchase('x', { count: 2.5 })],
      ['/api/purchases/x', purchase('x', { priceMinor: -1 })],
      ['/api/purchases/x', purchase('x', { priceMinor: 10.5 })],
      ['/api/purchases/x', purchase('x', { date: '26/09/2026' })],
      ['/api/purchases/x', purchase('x', { date: '2026-02-30' })],
      ['/api/settings', { currency: 'ISK', currencySymbol: 'kr.', weekStart: 8, sizes: ['1'], babyName: '' }],
      ['/api/settings', { currency: 'ISK', currencySymbol: 'kr.', weekStart: 1, sizes: [], babyName: '' }],
      ['/api/settings', { currency: 'ISK', currencySymbol: 'kr.', weekStart: 1, sizes: [''], babyName: '' }],
    ];
    for (const [url, body] of bad) {
      const r = await req('PUT', url, body);
      expect(r.statusCode, `${url} ${JSON.stringify(body)}`).toBe(400);
      expect(typeof r.json().error).toBe('string');
    }
  });

  it('purchases, costs, packs and stock in state', async () => {
    await req('PUT', '/api/purchases/p1', purchase('p1'));
    await req('PUT', '/api/purchases/p1', purchase('p1')); // idempotent
    await req('PUT', '/api/changes/c1', change('c1'));
    await req('PUT', '/api/changes/c2', change('c2', { time: '2026-09-26T09:00:00Z', type: 'dry' }));
    const s = (await req('GET', '/api/state')).json() as AppState;
    expect(s.purchases).toHaveLength(1);
    expect(s.changes.map((c) => c.id)).toEqual(['c2', 'c1']); // time desc
    expect(s.costs.c1).toEqual({ changeId: 'c1', costMinor: 5000, purchaseId: 'p1', estimated: false });
    expect(s.packs.p1).toEqual({ purchaseId: 'p1', perDiaperMinor: 5000, used: 2, remaining: 18 });
    expect(s.stock.find((x) => x.size === '3')).toEqual({ size: '3', bought: 20, used: 2, onHand: 18 });
    expect(s.stock[0].size).toBe('1');
    expect(s.settings.currency).toBe('ISK');
    expect(s.serverTime).toBe('2026-09-26T12:00:00.000Z');

    expect((await req('DELETE', '/api/purchases/p1')).json()).toEqual({ ok: true });
    expect((await req('DELETE', '/api/changes/c1')).json()).toEqual({ ok: true });
    expect((await req('DELETE', '/api/changes/missing')).json()).toEqual({ ok: true });
    const s2 = (await req('GET', '/api/state')).json() as AppState;
    expect(s2.purchases).toHaveLength(0);
    expect(s2.costs.c2).toMatchObject({ estimated: true, costMinor: 0 });
  });

  it('settings round-trip', async () => {
    const settings = { currency: 'EUR', currencySymbol: '€', weekStart: 7, sizes: ['NB', '1'], babyName: 'Jón' };
    expect((await req('PUT', '/api/settings', settings)).json()).toEqual(settings);
    expect(((await req('GET', '/api/state')).json() as AppState).settings).toEqual(settings);
  });

  it('reports with tz and now', async () => {
    await req('PUT', '/api/changes/c1', change('c1'));
    const r = await req('GET', '/api/reports?tz=Europe/Berlin&now=2026-09-26T12:00:00Z');
    expect(r.statusCode).toBe(200);
    const body = r.json() as ReportsResponse;
    expect(body.tz).toBe('Europe/Berlin');
    expect(body.periods.today.start).toBe('2026-09-25T22:00:00.000Z');
    expect(body.periods.today.diapers).toBe(1);
    const def = (await req('GET', '/api/reports')).json() as ReportsResponse;
    expect(def.tz).toBe('Atlantic/Reykjavik');
    expect(def.now).toBe('2026-09-26T12:00:00.000Z');
    expect((await req('GET', '/api/reports?tz=Nowhere/Land')).statusCode).toBe(400);
    expect((await req('GET', '/api/reports?now=garbage')).statusCode).toBe(400);
  });

  it('export/import round-trip replaces all data', async () => {
    await req('PUT', '/api/settings', {
      currency: 'ISK',
      currencySymbol: 'kr.',
      weekStart: 1,
      sizes: ['2', '3'],
      babyName: 'Baby',
    });
    await req('PUT', '/api/purchases/p1', purchase('p1'));
    await req('PUT', '/api/purchases/p2', purchase('p2', { count: 15, priceMinor: 89900 }));
    await req('PUT', '/api/changes/c1', change('c1', { note: 'n' }));
    await req('PUT', '/api/changes/c2', change('c2', { time: '2026-09-25T08:00:00Z' }));

    const ex = await req('GET', '/api/export');
    expect(ex.statusCode).toBe(200);
    expect(ex.headers['content-disposition']).toMatch(/^attachment; filename=".+\.json"$/);
    const data = ex.json() as ExportData;
    expect(data.version).toBe(1);
    expect(data.changes).toHaveLength(2);
    const before = (await req('GET', '/api/state')).json() as AppState;

    // Mutate, then import the snapshot back.
    await req('PUT', '/api/changes/c3', change('c3'));
    await req('DELETE', '/api/purchases/p1');
    await req('PUT', '/api/settings', { ...data.settings, babyName: 'Other' });

    const im = await req('POST', '/api/import', data);
    expect(im.json()).toEqual({ ok: true, changes: 2, purchases: 2 });
    const after = (await req('GET', '/api/state')).json() as AppState;
    expect({ ...after, serverTime: '' }).toEqual({ ...before, serverTime: '' });

    // Session survives an import.
    expect((await req('GET', '/api/session')).json()).toEqual({ authed: true });
  });

  it('invalid import changes nothing', async () => {
    await req('PUT', '/api/changes/c1', change('c1'));
    const data = (await req('GET', '/api/export')).json() as ExportData;
    const bad = { ...data, changes: [...data.changes, { ...change('c9'), type: 'nope' }] };
    const r = await req('POST', '/api/import', bad);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/changes\[1\]/);
    expect(((await req('GET', '/api/state')).json() as AppState).changes).toHaveLength(1);
  });

  it('unknown api route is JSON 404', async () => {
    const r = await req('GET', '/api/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not found' });
  });
});

describe('static client', () => {
  it('serves files, SPA fallback, no-cache on index.html and sw.js', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bleyjur-client-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>bleyjur</title>');
    fs.writeFileSync(path.join(dir, 'sw.js'), '// sw');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    const sdb = openDb(':memory:');
    const s = await buildApp({ db: sdb, pin: PIN, clientDir: dir });
    try {
      const root = await s.inject('/');
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('bleyjur');
      expect(root.headers['cache-control']).toBe('no-cache');

      const deep = await s.inject('/dashboard');
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain('bleyjur');
      expect(deep.headers['cache-control']).toBe('no-cache');

      const sw = await s.inject('/sw.js');
      expect(sw.headers['cache-control']).toBe('no-cache');

      const asset = await s.inject('/assets/app.js');
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).not.toBe('no-cache');

      expect((await s.inject('/assets/missing.js')).statusCode).toBe(404);
      expect((await s.inject('/api/missing')).statusCode).toBe(401);
      expect((await s.inject('/api/health')).statusCode).toBe(200);
    } finally {
      await s.close();
      sdb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips static serving when clientDir is missing', async () => {
    const sdb = openDb(':memory:');
    const s = await buildApp({ db: sdb, pin: PIN, clientDir: '/nonexistent/bleyjur' });
    expect((await s.inject('/')).statusCode).toBe(404);
    await s.close();
    sdb.close();
  });
});

describe('db', () => {
  it('migrates a file DB in WAL mode and is re-openable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bleyjur-db-'));
    const file = path.join(dir, 'sub', 'bleyjur.db');
    const d1 = openDb(file);
    expect(d1.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(d1.pragma('user_version', { simple: true })).toBe(1);
    d1.close();
    const d2 = openDb(file);
    expect(d2.pragma('user_version', { simple: true })).toBe(1);
    d2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
