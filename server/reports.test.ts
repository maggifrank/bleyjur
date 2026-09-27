import { describe, expect, it } from 'vitest';
import type { Change, ChangeType, Purchase } from '../shared/types.js';
import { computeCosts } from './costs.js';
import { buildReports } from './reports.js';

let n = 0;
const ch = (time: string, type: ChangeType = 'wet', size = '3'): Change => ({
  id: `c${++n}`,
  time,
  size,
  type,
  note: null,
  loggedBy: 'x',
});
const pk = (id: string, date: string, count: number, priceMinor: number, size = '3'): Purchase => ({
  id,
  date,
  size,
  brand: null,
  count,
  priceMinor,
  store: null,
  loggedBy: 'x',
});

function run(changes: Change[], purchases: Purchase[], now: string, tz?: string, weekStart?: number) {
  const { costs } = computeCosts(changes, purchases);
  return buildReports({ changes, purchases, costs, now, tz, weekStart });
}

describe('period boundaries (Atlantic/Reykjavik, UTC+0)', () => {
  // Saturday
  const now = '2026-09-26T10:00:00.000Z';
  const r = run([], [], now);

  it('defaults tz', () => {
    expect(r.tz).toBe('Atlantic/Reykjavik');
    expect(r.now).toBe(now);
  });

  it('today, week (Monday start), month', () => {
    expect(r.periods.today).toMatchObject({ start: '2026-09-26T00:00:00.000Z', end: now });
    expect(r.periods.weekToDate).toMatchObject({ start: '2026-09-21T00:00:00.000Z', end: now });
    expect(r.periods.lastWeek).toMatchObject({
      start: '2026-09-14T00:00:00.000Z',
      end: '2026-09-21T00:00:00.000Z',
    });
    expect(r.periods.monthToDate).toMatchObject({ start: '2026-09-01T00:00:00.000Z', end: now });
    expect(r.periods.lastMonth).toMatchObject({
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-09-01T00:00:00.000Z',
    });
    expect(r.weekly.weekStart).toBe('2026-09-14');
  });

  it('Sunday week start', () => {
    const s = run([], [], now, undefined, 7);
    expect(s.periods.weekToDate.start).toBe('2026-09-20T00:00:00.000Z');
    expect(s.periods.lastWeek.start).toBe('2026-09-13T00:00:00.000Z');
    expect(s.weekly.weekStart).toBe('2026-09-13');
  });

  it('on Monday at midnight the new week starts now', () => {
    const m = run([], [], '2026-09-21T00:00:00.000Z');
    expect(m.periods.weekToDate.start).toBe('2026-09-21T00:00:00.000Z');
    expect(m.periods.lastWeek.start).toBe('2026-09-14T00:00:00.000Z');
  });

  it('lastMonth across a year boundary', () => {
    const j = run([], [], '2026-01-15T12:00:00.000Z');
    expect(j.periods.lastMonth).toMatchObject({
      start: '2025-12-01T00:00:00.000Z',
      end: '2026-01-01T00:00:00.000Z',
    });
    // Week of Thu 2026-01-15 starts Mon 2026-01-12; last week spans the new year.
    expect(j.periods.lastWeek.start).toBe('2026-01-05T00:00:00.000Z');
    const y = run([], [], '2026-01-01T00:30:00.000Z');
    expect(y.periods.lastWeek).toMatchObject({
      start: '2025-12-22T00:00:00.000Z',
      end: '2025-12-29T00:00:00.000Z',
    });
  });
});

describe('counting', () => {
  const now = '2026-09-26T12:00:00.000Z'; // Sat, 12 hours into the day
  const changes = [
    ch('2026-09-26T11:59:59.000Z', 'wet'), // today
    ch('2026-09-26T00:00:00.000Z', 'dry'), // today, start inclusive
    ch('2026-09-26T12:00:00.000Z', 'wet'), // == now, excluded (end exclusive)
    ch('2026-09-25T23:59:59.000Z', 'dirty', '4'), // yesterday, this week
    ch('2026-09-21T00:00:00.000Z', 'both'), // Monday: this week
    ch('2026-09-20T23:59:59.000Z', 'wet'), // Sunday: last week
    ch('2026-09-14T00:00:00.000Z', 'wet'), // last week start
    ch('2026-09-13T12:00:00.000Z', 'wet'), // week before last
    ch('2026-08-31T23:00:00.000Z', 'dirty'), // last month
    ch('2026-08-01T00:00:00.000Z', 'wet'), // last month
    ch('2026-07-31T23:59:59.000Z', 'wet'), // before
  ];
  const purchases = [
    pk('a', '2026-07-01', 5, 5000),
    pk('b', '2026-08-15', 100, 200000),
    pk('c', '2026-09-26', 10, 30000), // today
    pk('d', '2026-09-21', 10, 10000), // this week (Monday)
    pk('e', '2026-09-20', 10, 20000), // last week (Sunday)
    pk('f', '2026-09-01', 10, 40000), // month start
  ];
  const r = run(changes, purchases, now);
  const P = r.periods;

  it('diapers per period with [start, end)', () => {
    expect(P.today.diapers).toBe(2);
    expect(P.weekToDate.diapers).toBe(4);
    expect(P.lastWeek.diapers).toBe(2);
    expect(P.monthToDate.diapers).toBe(7);
    expect(P.lastMonth.diapers).toBe(2);
  });

  it('breakdowns', () => {
    expect(P.today.byType).toEqual({ wet: 1, dirty: 0, both: 0, dry: 1 });
    expect(P.weekToDate.bySize).toEqual({ '3': 3, '4': 1 });
    expect(P.weekToDate.byType).toEqual({ wet: 1, dirty: 1, both: 1, dry: 1 });
  });

  it('costs sum change costs, flag estimated', () => {
    // FIFO size 3: a(5 @1000) then b(@2000)... sorted by time: 07-31 -> a
    expect(P.lastMonth.costMinor).toBe(2 * 1000);
    expect(P.lastMonth.costEstimated).toBe(false);
    // size 4 has no pack -> estimated from most recent pack of any size (c: 3000/diaper)
    expect(P.weekToDate.costEstimated).toBe(true);
    expect(P.today.costEstimated).toBe(false);
  });

  it('average per day', () => {
    expect(P.today.avgPerDay).toBe(2); // 0.5 days elapsed -> min 1 day
    expect(P.weekToDate.avgPerDay).toBeCloseTo(4 / 5.5, 10);
    expect(P.lastWeek.avgPerDay).toBeCloseTo(2 / 7, 10);
    expect(P.monthToDate.avgPerDay).toBeCloseTo(7 / 25.5, 10);
    expect(P.lastMonth.avgPerDay).toBeCloseTo(2 / 31, 10);
  });

  it('spent on packs by local purchase date', () => {
    expect(P.today.spentMinor).toBe(30000);
    expect(P.weekToDate.spentMinor).toBe(40000);
    expect(P.lastWeek.spentMinor).toBe(20000);
    expect(P.monthToDate.spentMinor).toBe(100000);
    expect(P.lastMonth.spentMinor).toBe(200000);
  });

  it('weekly summary compares with week before', () => {
    expect(r.weekly).toEqual({
      weekStart: '2026-09-14',
      diapers: 2,
      costMinor: P.lastWeek.costMinor,
      costEstimated: false,
      prevDiapers: 1,
      prevCostMinor: 1000,
    });
  });
});

describe('non-UTC time zone (Europe/Berlin, across DST)', () => {
  // Monday 2026-03-30 10:00 CEST (DST began Sun 2026-03-29).
  const now = '2026-03-30T08:00:00.000Z';
  const tz = 'Europe/Berlin';

  it('boundaries are local midnights', () => {
    const r = run([], [], now, tz);
    expect(r.tz).toBe(tz);
    expect(r.periods.today.start).toBe('2026-03-29T22:00:00.000Z');
    expect(r.periods.weekToDate.start).toBe('2026-03-29T22:00:00.000Z');
    expect(r.periods.lastWeek).toMatchObject({
      start: '2026-03-22T23:00:00.000Z',
      end: '2026-03-29T22:00:00.000Z',
    });
    expect(r.periods.monthToDate.start).toBe('2026-02-28T23:00:00.000Z');
    expect(r.periods.lastMonth).toMatchObject({
      start: '2026-01-31T23:00:00.000Z',
      end: '2026-02-28T23:00:00.000Z',
    });
    expect(r.weekly.weekStart).toBe('2026-03-23');
  });

  it('a 167-hour DST week still averages over 7 days; Feb over 28', () => {
    const changes = Array.from({ length: 14 }, (_, i) => ch(new Date(Date.parse('2026-03-23T00:00:00Z') + i * 11 * 3600_000).toISOString()));
    const r = run(changes, [], now, tz);
    expect(r.periods.lastWeek.diapers).toBe(14);
    expect(r.periods.lastWeek.avgPerDay).toBe(2);
    const feb = run([ch('2026-02-10T12:00:00Z')], [], now, tz);
    expect(feb.periods.lastMonth.avgPerDay).toBeCloseTo(1 / 28, 10);
  });

  it('assigns changes to the local day', () => {
    // 23:30 UTC on 29 Mar is 01:30 on 30 Mar in Berlin: today. 21:30 UTC is yesterday.
    const r = run([ch('2026-03-29T23:30:00Z'), ch('2026-03-29T21:30:00Z')], [], now, tz);
    expect(r.periods.today.diapers).toBe(1);
    expect(r.periods.lastWeek.diapers).toBe(1);
  });

  it('rejects invalid tz', () => {
    expect(() => run([], [], now, 'Mars/Olympus')).toThrow(/time zone/);
  });
});
