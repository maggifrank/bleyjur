// API contract shared by server and client. Server imports with a `.js`
// suffix (NodeNext); the client imports without one (Vite).

export type ChangeType = 'wet' | 'dirty' | 'both' | 'dry';
export const CHANGE_TYPES: ChangeType[] = ['wet', 'dirty', 'both', 'dry'];

/** A logged diaper change. `id` is a client-generated UUID. */
export interface Change {
  id: string;
  /** ISO 8601 instant with offset, e.g. 2026-09-26T08:15:00.000Z */
  time: string;
  size: string;
  type: ChangeType;
  note: string | null;
  loggedBy: string;
}

/**
 * A pack purchase. Money is stored in minor units (aurar: 1 kr. = 100),
 * so 899 kr. is `priceMinor: 89900`.
 */
export interface Purchase {
  id: string;
  /** Local calendar date, YYYY-MM-DD */
  date: string;
  size: string;
  brand: string | null;
  count: number;
  priceMinor: number;
  store: string | null;
  loggedBy: string;
}

export interface Settings {
  /** ISO 4217 code, default 'ISK' */
  currency: string;
  /** Display symbol, default 'kr.' */
  currencySymbol: string;
  /** 1 = Monday ... 7 = Sunday (ISO weekday). Default 1. */
  weekStart: number;
  /** Ordered list of sizes offered in the UI. Default ['1','2','3','4','5','6']. */
  sizes: string[];
  babyName: string;
}

/** Cost assigned to one change by FIFO over same-size packs. */
export interface ChangeCost {
  changeId: string;
  /** Minor units, fractional allowed (e.g. 5993.33). Round only for display. */
  costMinor: number;
  /** Pack the diaper was drawn from, or null if no pack covered it. */
  purchaseId: string | null;
  /** True when no pack covered this change and a fallback price was used. */
  estimated: boolean;
}

export interface PackStatus {
  purchaseId: string;
  /** priceMinor / count, fractional */
  perDiaperMinor: number;
  used: number;
  remaining: number;
}

export interface StockBySize {
  size: string;
  bought: number;
  used: number;
  /** bought - used; may be negative if more changes than purchases were logged */
  onHand: number;
}

/** Everything the client needs to render, returned by GET /api/state. */
export interface AppState {
  changes: Change[]; // sorted by time descending
  purchases: Purchase[]; // sorted by date descending
  settings: Settings;
  costs: Record<string, ChangeCost>; // keyed by change id
  packs: Record<string, PackStatus>; // keyed by purchase id
  stock: StockBySize[]; // in settings.sizes order, then any other sizes seen
  /** Server time, ISO. */
  serverTime: string;
}

export type PeriodKey = 'today' | 'weekToDate' | 'lastWeek' | 'monthToDate' | 'lastMonth';
export const PERIOD_KEYS: PeriodKey[] = ['today', 'weekToDate', 'lastWeek', 'monthToDate', 'lastMonth'];

export interface PeriodReport {
  key: PeriodKey;
  /** ISO instants, [start, end) */
  start: string;
  end: string;
  diapers: number;
  bySize: Record<string, number>;
  byType: Record<ChangeType, number>;
  costMinor: number;
  /** True if any change in the period has an estimated cost. */
  costEstimated: boolean;
  /** diapers / days elapsed in the period (partial days count as fractional, min 1 day). */
  avgPerDay: number;
  /** Sum of priceMinor for purchases whose date falls in the period. */
  spentMinor: number;
}

export interface WeeklySummary {
  /** ISO date of the Monday (week start) of last week */
  weekStart: string;
  diapers: number;
  costMinor: number;
  costEstimated: boolean;
  /** Week before last, for comparison */
  prevDiapers: number;
  prevCostMinor: number;
}

/** GET /api/reports?tz=Atlantic/Reykjavik[&now=ISO] */
export interface ReportsResponse {
  tz: string;
  now: string;
  periods: Record<PeriodKey, PeriodReport>;
  weekly: WeeklySummary;
}

/** GET/POST /api/export and /api/import body. */
export interface ExportData {
  version: 1;
  exportedAt: string;
  settings: Settings;
  changes: Change[];
  purchases: Purchase[];
}

/*
 * Endpoints (all JSON; all except /api/health and /api/login require the
 * session cookie `bleyjur_session`, else 401 {error:'unauthorized'}):
 *
 * GET    /api/health                 -> 200 {ok:true} (checks DB), no auth
 * POST   /api/login  {pin}           -> 200 {ok:true} + Set-Cookie; 401 wrong pin; 429 rate limited
 * GET    /api/session                -> {authed:boolean}  (no auth required)
 * POST   /api/logout                 -> {ok:true}
 * GET    /api/state                  -> AppState
 * GET    /api/reports?tz=&now=       -> ReportsResponse
 * PUT    /api/changes/:id   Change   -> Change   (upsert, idempotent; body.id must equal :id)
 * DELETE /api/changes/:id            -> {ok:true} (404-safe: deleting missing id is ok)
 * PUT    /api/purchases/:id Purchase -> Purchase (upsert)
 * DELETE /api/purchases/:id          -> {ok:true}
 * PUT    /api/settings      Settings -> Settings
 * GET    /api/export                 -> ExportData (Content-Disposition attachment)
 * POST   /api/import        ExportData -> {ok:true, changes:n, purchases:n}  (replaces all data)
 *
 * Validation errors -> 400 {error:string}.
 */
