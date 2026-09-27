// App-wide state, server sync and the offline write queue.
//
// All writes go through a persistent FIFO queue (localStorage). The queue is
// applied optimistically on top of the last server state, then flushed in
// order. Network failures leave ops queued and they are retried on
// reconnect / focus / every 30 s. Records carry client UUIDs and the server
// upserts, so retries never create duplicates.
import { useEffect, useState } from 'preact/hooks';
import type {
  AppState,
  Change,
  ExportData,
  Purchase,
  ReportsResponse,
  Settings,
} from '../../shared/types';
import { STRINGS, loadLang, saveLang, type Lang } from './i18n';
import { readJSON, readString, timeZone, uuid, writeJSON, writeString } from './util';

export type Op =
  | { kind: 'putChange'; change: Change }
  | { kind: 'deleteChange'; id: string }
  | { kind: 'putPurchase'; purchase: Purchase }
  | { kind: 'deletePurchase'; id: string }
  | { kind: 'putSettings'; settings: Settings };

export type QueuedOp = Op & { qid: string };

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  text: string;
  resolve: (ok: boolean) => void;
}

export interface StoreState {
  auth: 'checking' | 'authed' | 'login';
  server: AppState | null;
  reports: ReportsResponse | null;
  queue: QueuedOp[];
  /** Whether the last request reached the server. */
  online: boolean;
  lang: Lang;
  parentName: string;
  lastSize: string;
  toast: Toast | null;
  confirm: ConfirmRequest | null;
}

const K = {
  state: 'bleyjur.state',
  reports: 'bleyjur.reports',
  queue: 'bleyjur.queue',
  parent: 'bleyjur.parentName',
  size: 'bleyjur.lastSize',
  weekly: 'bleyjur.weeklyDismissed',
};

let state: StoreState = {
  auth: 'checking',
  server: readJSON<AppState | null>(K.state, null),
  reports: readJSON<ReportsResponse | null>(K.reports, null),
  queue: readJSON<QueuedOp[]>(K.queue, []),
  online: true,
  lang: loadLang(),
  parentName: readString(K.parent),
  lastSize: readString(K.size),
  toast: null,
  confirm: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getState(): StoreState {
  return state;
}

export function useStore(): StoreState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

export function t() {
  return STRINGS[state.lang];
}

// ---------- local preferences ----------

export function setLang(lang: Lang): void {
  saveLang(lang);
  set({ lang });
}

export function setParentName(name: string): void {
  writeString(K.parent, name.trim());
  set({ parentName: name.trim() });
}

export function setLastSize(size: string): void {
  writeString(K.size, size);
  set({ lastSize: size });
}

export function weeklyDismissedFor(): string {
  return readString(K.weekly);
}

export function dismissWeekly(weekStart: string): void {
  writeString(K.weekly, weekStart);
  set({}); // re-render
}

// ---------- toasts and confirm ----------

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(text: string, action?: Toast['action'], ms = 5000): void {
  clearTimeout(toastTimer);
  const id = ++toastSeq;
  set({ toast: { id, text, action } });
  toastTimer = setTimeout(() => {
    if (state.toast?.id === id) set({ toast: null });
  }, ms);
}

export function hideToast(): void {
  clearTimeout(toastTimer);
  set({ toast: null });
}

export function confirmDialog(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    state.confirm?.resolve(false);
    set({
      confirm: {
        text,
        resolve: (ok) => {
          set({ confirm: null });
          resolve(ok);
        },
      },
    });
  });
}

// ---------- HTTP ----------

class NetworkError extends Error {}

interface Res<T> {
  status: number;
  ok: boolean;
  data: T;
  headers: Headers;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new NetworkError(String(e));
  }
  let data: unknown = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 401 && path !== '/api/login') {
    onUnauthorized();
  }
  return { status: res.status, ok: res.ok, data: data as T, headers: res.headers };
}

function onUnauthorized(): void {
  if (state.auth !== 'login') set({ auth: 'login' });
}

function errorText(data: unknown, status: number): string {
  if (data && typeof data === 'object' && 'error' in data) return String((data as { error: unknown }).error);
  return `HTTP ${status}`;
}

// ---------- auth ----------

export async function checkSession(): Promise<void> {
  try {
    const r = await request<{ authed: boolean }>('GET', '/api/session');
    if (r.ok && r.data?.authed) {
      set({ auth: 'authed', online: true });
      void sync();
    } else {
      set({ auth: 'login', online: r.status < 500 });
    }
  } catch {
    // Offline: render from cache if we have one, otherwise show login.
    set({ auth: state.server ? 'authed' : 'login', online: false });
  }
}

export type LoginResult = { ok: true } | { ok: false; reason: 'wrong' | 'rate' | 'offline' | 'error'; retryAfter?: number };

export async function login(pin: string): Promise<LoginResult> {
  try {
    const r = await request<{ ok?: boolean; retryAfter?: number; error?: string }>('POST', '/api/login', { pin });
    if (r.ok) {
      set({ auth: 'authed', online: true });
      void sync();
      return { ok: true };
    }
    if (r.status === 401) return { ok: false, reason: 'wrong' };
    if (r.status === 429) {
      const header = Number(r.headers.get('Retry-After'));
      const retryAfter = Number(r.data?.retryAfter) || (isFinite(header) && header > 0 ? header : 60);
      return { ok: false, reason: 'rate', retryAfter: Math.ceil(retryAfter) };
    }
    return { ok: false, reason: 'error' };
  } catch {
    set({ online: false });
    return { ok: false, reason: 'offline' };
  }
}

export async function logout(): Promise<void> {
  try {
    await request('POST', '/api/logout');
  } catch {
    /* ignore */
  }
  writeJSON(K.state, null);
  writeJSON(K.reports, null);
  set({ auth: 'login', server: null, reports: null });
}

// ---------- sync ----------

let writeSeq = 0;
let refreshing: Promise<void> | null = null;

async function refreshOnce(): Promise<void> {
  const seq = writeSeq;
  try {
    const [s, r] = await Promise.all([
      request<AppState>('GET', '/api/state'),
      request<ReportsResponse>('GET', `/api/reports?tz=${encodeURIComponent(timeZone())}`),
    ]);
    if (!s.ok || !r.ok) {
      set({ online: s.status < 500 && r.status < 500 });
      return;
    }
    // A write landed while we were fetching: the response may predate it.
    if (seq !== writeSeq) return refreshOnce();
    writeJSON(K.state, s.data);
    writeJSON(K.reports, r.data);
    set({ server: s.data, reports: r.data, online: true });
  } catch (e) {
    if (e instanceof NetworkError) set({ online: false });
    else throw e;
  }
}

export function refresh(): Promise<void> {
  if (state.auth !== 'authed') return Promise.resolve();
  if (!refreshing) {
    refreshing = refreshOnce().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

let flushing: Promise<void> | null = null;
/** qid of the op currently being sent. */
let inFlight: string | null = null;

function opRequest(op: Op): [string, string, unknown?] {
  switch (op.kind) {
    case 'putChange':
      return ['PUT', `/api/changes/${encodeURIComponent(op.change.id)}`, op.change];
    case 'deleteChange':
      return ['DELETE', `/api/changes/${encodeURIComponent(op.id)}`];
    case 'putPurchase':
      return ['PUT', `/api/purchases/${encodeURIComponent(op.purchase.id)}`, op.purchase];
    case 'deletePurchase':
      return ['DELETE', `/api/purchases/${encodeURIComponent(op.id)}`];
    case 'putSettings':
      return ['PUT', '/api/settings', op.settings];
  }
}

function saveQueue(queue: QueuedOp[]): void {
  writeJSON(K.queue, queue);
  set({ queue });
}

async function flushOnce(): Promise<void> {
  while (state.queue.length > 0 && state.auth === 'authed') {
    const op = state.queue[0];
    const [method, path, body] = opRequest(op);
    let r: Res<unknown>;
    inFlight = op.qid;
    try {
      r = await request(method, path, body);
    } catch {
      set({ online: false });
      return;
    } finally {
      inFlight = null;
    }
    if (r.status === 401) return; // back to login; keep the op
    if (r.status >= 500 || r.status === 408 || r.status === 429) {
      set({ online: r.status < 500 });
      return; // retry later
    }
    writeSeq++;
    // 2xx, or a 4xx the server will never accept: drop it either way.
    saveQueue(state.queue.filter((q) => q.qid !== op.qid));
    if (!r.ok && !(op.kind.startsWith('delete') && r.status === 404)) {
      showToast(`${t().syncError} ${errorText(r.data, r.status)}`, undefined, 8000);
    }
    set({ online: true });
  }
}

export function flush(): Promise<void> {
  if (!flushing) {
    flushing = flushOnce().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

export async function sync(): Promise<void> {
  if (state.auth !== 'authed') return;
  await flush();
  await refresh();
}

export function enqueue(op: Op): void {
  saveQueue([...state.queue, { ...op, qid: uuid() }]);
  void sync();
}

/** Drop a still-queued write (used by undo before it reached the server). */
export function unqueuePut(id: string): boolean {
  const idx = state.queue.findIndex(
    (q) => q.qid !== inFlight && q.kind === 'putChange' && q.change.id === id,
  );
  if (idx < 0) return false;
  saveQueue(state.queue.filter((_, i) => i !== idx));
  return true;
}

// ---------- optimistic view ----------

let viewCache: { server: AppState | null; queue: QueuedOp[]; view: AppState | null } | null = null;

/** Server state with queued (unsynced) writes applied on top. */
export function currentView(): AppState | null {
  if (viewCache && viewCache.server === state.server && viewCache.queue === state.queue) return viewCache.view;
  let view = state.server;
  if (view && state.queue.length) {
    let changes = view.changes;
    let purchases = view.purchases;
    let settings = view.settings;
    for (const op of state.queue) {
      switch (op.kind) {
        case 'putChange':
          changes = [...changes.filter((c) => c.id !== op.change.id), op.change];
          break;
        case 'deleteChange':
          changes = changes.filter((c) => c.id !== op.id);
          break;
        case 'putPurchase':
          purchases = [...purchases.filter((p) => p.id !== op.purchase.id), op.purchase];
          break;
        case 'deletePurchase':
          purchases = purchases.filter((p) => p.id !== op.id);
          break;
        case 'putSettings':
          settings = op.settings;
          break;
      }
    }
    changes = [...changes].sort((a, b) => b.time.localeCompare(a.time));
    purchases = [...purchases].sort((a, b) => b.date.localeCompare(a.date));
    view = { ...view, changes, purchases, settings };
  }
  viewCache = { server: state.server, queue: state.queue, view };
  return view;
}

/** Ids of records with a write still waiting to reach the server. */
export function pendingIds(): Set<string> {
  const ids = new Set<string>();
  for (const op of state.queue) {
    if (op.kind === 'putChange') ids.add(op.change.id);
    else if (op.kind === 'putPurchase') ids.add(op.purchase.id);
  }
  return ids;
}

// ---------- import ----------

export async function importData(data: ExportData): Promise<{ changes: number; purchases: number } | string> {
  try {
    const r = await request<{ ok: boolean; changes: number; purchases: number; error?: string }>(
      'POST',
      '/api/import',
      data,
    );
    if (!r.ok) return errorText(r.data, r.status);
    writeSeq++;
    await refresh();
    return { changes: r.data.changes, purchases: r.data.purchases };
  } catch {
    set({ online: false });
    return t().importNeedsOnline;
  }
}

// ---------- lifecycle ----------

export function startSyncLoop(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') void sync();
  };
  const onFocus = () => void sync();
  const onOnline = () => void sync();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void sync();
  }, 30_000);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
    clearInterval(timer);
  };
}
