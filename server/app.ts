import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { AppState } from '../shared/types.js';
import { Store, type DB } from './db.js';
import { computeCosts } from './costs.js';
import { buildReports, DEFAULT_TZ, isValidTz } from './reports.js';
import { ValidationError, validateChange, validateExport, validatePurchase, validateSettings } from './validate.js';

export const SESSION_COOKIE = 'bleyjur_session';
const ONE_YEAR_S = 365 * 24 * 60 * 60;

export interface BuildAppOptions {
  db: DB;
  pin: string;
  /** Directory of the built client. Static serving is skipped if missing. */
  clientDir?: string;
  logger?: boolean;
  /** Clock override for tests (ms since epoch). */
  now?: () => number;
}

/** Wrong-PIN limiter: after MAX_FREE failures, lock for BASE_LOCK_S doubling up to MAX_LOCK_S. */
const MAX_FREE_FAILURES = 5;
const BASE_LOCK_S = 30;
const MAX_LOCK_S = 15 * 60;

interface Attempts {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

export class LoginLimiter {
  private map = new Map<string, Attempts>();
  constructor(private now: () => number) {}

  /** Seconds until the client may try again, or 0. */
  retryAfter(key: string): number {
    const a = this.map.get(key);
    if (!a) return 0;
    const ms = a.lockedUntil - this.now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  fail(key: string): number {
    const now = this.now();
    let a = this.map.get(key);
    // Forget old failures after a quiet day.
    if (!a || now - a.lastFailure > 24 * 3600_000) a = { failures: 0, lockedUntil: 0, lastFailure: now };
    a.failures++;
    a.lastFailure = now;
    if (a.failures >= MAX_FREE_FAILURES) {
      const lockS = Math.min(MAX_LOCK_S, BASE_LOCK_S * 2 ** (a.failures - MAX_FREE_FAILURES));
      a.lockedUntil = now + lockS * 1000;
    }
    this.map.set(key, a);
    // Keep the map bounded.
    if (this.map.size > 10_000) {
      for (const [k, v] of this.map) if (v.lockedUntil < now) this.map.delete(k);
    }
    return this.retryAfter(key);
  }

  succeed(key: string): void {
    this.map.delete(key);
  }
}

function pinMatches(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) && expected.length > 0;
}

const PUBLIC_API = new Set(['/api/health', '/api/login', '/api/session']);
const NO_CACHE_FILES = new Set(['index.html', 'sw.js']);

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const store = new Store(opts.db);
  const now = opts.now ?? Date.now;
  const limiter = new LoginLimiter(now);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024 });

  await app.register(fastifyCookie);

  const sessionToken = (req: FastifyRequest): string | null => {
    const t = req.cookies[SESSION_COOKIE];
    return t && store.hasSession(t) ? t : null;
  };

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (code >= 500) req.log.error(err);
    return reply.code(code).send({ error: code >= 500 ? 'internal error' : err.message });
  });

  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (!p.startsWith('/api/') || PUBLIC_API.has(p)) return;
    if (!sessionToken(req)) return reply.code(401).send({ error: 'unauthorized' });
  });

  // --- public ---
  app.get('/api/health', async (_req, reply) => {
    try {
      store.ping();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get('/api/session', async (req) => ({ authed: !!sessionToken(req) }));

  app.post('/api/login', async (req, reply) => {
    const key = req.ip;
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      reply.header('Retry-After', String(wait));
      return reply.code(429).send({ error: 'too many attempts', retryAfter: wait });
    }
    const body = req.body as { pin?: unknown } | undefined;
    const pin = body && typeof body === 'object' ? body.pin : undefined;
    if (typeof pin !== 'string' && typeof pin !== 'number') throw new ValidationError('pin is required');
    if (!pinMatches(String(pin), opts.pin)) {
      const retryAfter = limiter.fail(key);
      // The attempt itself was a wrong PIN (401); if it triggered a lock, say how long.
      return reply.code(401).send(retryAfter > 0 ? { error: 'wrong pin', retryAfter } : { error: 'wrong pin' });
    }
    limiter.succeed(key);
    const token = crypto.randomBytes(32).toString('base64url');
    store.createSession(token);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_YEAR_S,
      secure: false,
    });
    return { ok: true };
  });

  // --- authed ---
  app.post('/api/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) store.deleteSession(t);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/state', async (): Promise<AppState> => {
    const settings = store.getSettings();
    const changes = store.listChanges();
    const { costs, packs, stock } = computeCosts(changes, store.listPurchasesInsertionOrder(), settings.sizes);
    return {
      changes,
      purchases: store.listPurchases(),
      settings,
      costs,
      packs,
      stock,
      serverTime: new Date(now()).toISOString(),
    };
  });

  app.get('/api/reports', async (req) => {
    const q = req.query as { tz?: string; now?: string };
    const tz = q.tz || DEFAULT_TZ;
    if (!isValidTz(tz)) throw new ValidationError('invalid tz');
    let at = new Date(now());
    if (q.now) {
      at = new Date(q.now);
      if (Number.isNaN(at.getTime())) throw new ValidationError('invalid now');
    }
    const settings = store.getSettings();
    const changes = store.listChanges();
    const purchases = store.listPurchasesInsertionOrder();
    const { costs } = computeCosts(changes, purchases, settings.sizes);
    return buildReports({ changes, purchases, costs, tz, now: at, weekStart: settings.weekStart });
  });

  app.put('/api/changes/:id', async (req) => {
    const { id } = req.params as { id: string };
    return store.upsertChange(validateChange(req.body, id));
  });
  app.delete('/api/changes/:id', async (req) => {
    store.deleteChange((req.params as { id: string }).id);
    return { ok: true };
  });

  app.put('/api/purchases/:id', async (req) => {
    const { id } = req.params as { id: string };
    return store.upsertPurchase(validatePurchase(req.body, id));
  });
  app.delete('/api/purchases/:id', async (req) => {
    store.deletePurchase((req.params as { id: string }).id);
    return { ok: true };
  });

  app.put('/api/settings', async (req) => store.putSettings(validateSettings(req.body)));

  app.get('/api/export', async (_req, reply) => {
    const data = store.exportAll();
    const stamp = data.exportedAt.slice(0, 10);
    reply.header('Content-Disposition', `attachment; filename="bleyjur-export-${stamp}.json"`);
    return data;
  });

  app.post('/api/import', async (req) => {
    const data = validateExport(req.body);
    store.importAll(data);
    return { ok: true, changes: data.changes.length, purchases: data.purchases.length };
  });

  // --- static client ---
  const clientDir = opts.clientDir;
  const hasClient = !!clientDir && fs.existsSync(path.join(clientDir, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: clientDir,
      setHeaders(reply, filePath) {
        if (NO_CACHE_FILES.has(path.basename(filePath))) reply.header('Cache-Control', 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const p = req.url.split('?')[0];
    const looksLikeFile = path.posix.basename(p).includes('.');
    if (hasClient && (req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/') && p !== '/api' && !looksLikeFile) {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  return app;
}
