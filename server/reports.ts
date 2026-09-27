// Pure period reports. No DB access.
import { DateTime, IANAZone } from 'luxon';
import type {
  Change,
  ChangeCost,
  ChangeType,
  PeriodKey,
  PeriodReport,
  Purchase,
  ReportsResponse,
  WeeklySummary,
} from '../shared/types.js';

export const DEFAULT_TZ = 'Atlantic/Reykjavik';

export function isValidTz(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export interface ReportInput {
  changes: Change[];
  purchases: Purchase[];
  costs: Record<string, ChangeCost>;
  /** IANA zone; defaults to Atlantic/Reykjavik. Throws if invalid. */
  tz?: string;
  now: Date | string;
  /** ISO weekday 1 (Mon) .. 7 (Sun). Default 1. */
  weekStart?: number;
}

interface Range {
  start: DateTime;
  end: DateTime;
  /** Whether the range ends at "now" (to-date) or is a complete period. */
  toDate: boolean;
}

const MS_PER_DAY = 86_400_000;

export function startOfWeek(dt: DateTime, weekStart: number): DateTime {
  const day = dt.startOf('day');
  return day.minus({ days: (day.weekday - weekStart + 7) % 7 });
}

export function periodRanges(now: DateTime, weekStart: number): Record<PeriodKey, Range> {
  const today = now.startOf('day');
  const week = startOfWeek(now, weekStart);
  const month = now.startOf('month');
  return {
    today: { start: today, end: now, toDate: true },
    weekToDate: { start: week, end: now, toDate: true },
    lastWeek: { start: week.minus({ weeks: 1 }), end: week, toDate: false },
    monthToDate: { start: month, end: now, toDate: true },
    lastMonth: { start: month.minus({ months: 1 }), end: month, toDate: false },
  };
}

interface Tally {
  diapers: number;
  bySize: Record<string, number>;
  byType: Record<ChangeType, number>;
  costMinor: number;
  costEstimated: boolean;
}

function tally(changes: { c: Change; t: number }[], costs: Record<string, ChangeCost>, start: number, end: number): Tally {
  const out: Tally = {
    diapers: 0,
    bySize: {},
    byType: { wet: 0, dirty: 0, both: 0, dry: 0 },
    costMinor: 0,
    costEstimated: false,
  };
  for (const { c, t } of changes) {
    if (t < start || t >= end) continue;
    out.diapers++;
    out.bySize[c.size] = (out.bySize[c.size] ?? 0) + 1;
    out.byType[c.type]++;
    const cost = costs[c.id];
    if (cost) {
      out.costMinor += cost.costMinor;
      if (cost.estimated) out.costEstimated = true;
    }
  }
  return out;
}

export function buildReports(input: ReportInput): ReportsResponse {
  const tz = input.tz ?? DEFAULT_TZ;
  if (!isValidTz(tz)) throw new Error(`Invalid time zone: ${tz}`);
  const weekStart = input.weekStart ?? 1;
  const nowJs = typeof input.now === 'string' ? new Date(input.now) : input.now;
  if (Number.isNaN(nowJs.getTime())) throw new Error('Invalid now');
  const now = DateTime.fromJSDate(nowJs, { zone: tz });

  const changes = input.changes.map((c) => ({ c, t: Date.parse(c.time) }));
  const ranges = periodRanges(now, weekStart);

  const periods = {} as Record<PeriodKey, PeriodReport>;
  for (const key of Object.keys(ranges) as PeriodKey[]) {
    const r = ranges[key];
    const s = r.start.toMillis();
    const e = r.end.toMillis();
    const t = tally(changes, input.costs, s, e);

    const days = r.toDate
      ? Math.max(1, (e - s) / MS_PER_DAY)
      : Math.max(1, Math.round(r.end.diff(r.start, 'days').days));

    // Purchase dates are local calendar dates.
    const startDate = r.start.toISODate()!;
    const endDate = r.end.toISODate()!;
    const spentMinor = input.purchases
      .filter((p) => p.date >= startDate && (r.toDate ? p.date <= endDate : p.date < endDate))
      .reduce((sum, p) => sum + p.priceMinor, 0);

    periods[key] = {
      key,
      start: r.start.toUTC().toISO()!,
      end: r.end.toUTC().toISO()!,
      ...t,
      avgPerDay: t.diapers / days,
      spentMinor,
    };
  }

  const lw = ranges.lastWeek;
  const prevStart = lw.start.minus({ weeks: 1 });
  const prev = tally(changes, input.costs, prevStart.toMillis(), lw.start.toMillis());
  const weekly: WeeklySummary = {
    weekStart: lw.start.toISODate()!,
    diapers: periods.lastWeek.diapers,
    costMinor: periods.lastWeek.costMinor,
    costEstimated: periods.lastWeek.costEstimated,
    prevDiapers: prev.diapers,
    prevCostMinor: prev.costMinor,
  };

  return { tz, now: nowJs.toISOString(), periods, weekly };
}
