import { describe, expect, it } from 'vitest';
import type { Change, ChangeType, Purchase } from '../shared/types.js';
import { computeCosts } from './costs.js';

let n = 0;
function change(time: string, size = '3', type: ChangeType = 'wet', id = `c${++n}`): Change {
  return { id, time, size, type, note: null, loggedBy: 'Mamma' };
}
function pack(id: string, date: string, count: number, priceMinor: number, size = '3'): Purchase {
  return { id, date, size, brand: null, count, priceMinor, store: null, loggedBy: 'Pabbi' };
}

/** n changes, one per hour from 2026-09-01T00:00Z. */
function changes(count: number, size = '3', type: ChangeType = 'wet', prefix = 'c'): Change[] {
  return Array.from({ length: count }, (_, i) =>
    change(new Date(Date.UTC(2026, 8, 1, i)).toISOString(), size, type, `${prefix}${i}`),
  );
}

describe('computeCosts', () => {
  it('spec example: 20 for 1000 kr., then 15 for 899 kr., FIFO spill-over', () => {
    const packs = [pack('p2', '2026-09-10', 15, 89900), pack('p1', '2026-09-01', 20, 100000)];
    const cs = changes(25);
    const r = computeCosts(cs, packs, ['3']);

    for (let i = 0; i < 20; i++) {
      expect(r.costs[`c${i}`]).toEqual({ changeId: `c${i}`, costMinor: 5000, purchaseId: 'p1', estimated: false });
    }
    for (let i = 20; i < 25; i++) {
      expect(r.costs[`c${i}`].purchaseId).toBe('p2');
      expect(r.costs[`c${i}`].costMinor).toBeCloseTo(89900 / 15, 10);
      expect(r.costs[`c${i}`].estimated).toBe(false);
    }
    expect(r.costs.c20.costMinor).toBeCloseTo(5993.333, 3);
    expect(r.packs.p1).toEqual({ purchaseId: 'p1', perDiaperMinor: 5000, used: 20, remaining: 0 });
    expect(r.packs.p2).toMatchObject({ used: 5, remaining: 10 });
    expect(r.stock).toEqual([{ size: '3', bought: 35, used: 25, onHand: 10 }]);
  });

  it('assigns by change time, not input order', () => {
    const cs = changes(3).reverse();
    const r = computeCosts(cs, [pack('a', '2026-09-01', 1, 100), pack('b', '2026-09-02', 5, 1000)]);
    expect(r.costs.c0.purchaseId).toBe('a');
    expect(r.costs.c1.purchaseId).toBe('b');
    expect(r.costs.c2.purchaseId).toBe('b');
  });

  it('same-date packs are consumed in insertion order', () => {
    const r = computeCosts(changes(2), [pack('first', '2026-09-01', 1, 100), pack('second', '2026-09-01', 1, 200)]);
    expect(r.costs.c0.purchaseId).toBe('first');
    expect(r.costs.c1.purchaseId).toBe('second');
  });

  it('dry changes count as used diapers', () => {
    const cs = changes(3, '3', 'dry');
    const r = computeCosts(cs, [pack('p', '2026-09-01', 10, 10000)]);
    expect(r.costs.c0).toMatchObject({ costMinor: 1000, estimated: false });
    expect(r.packs.p).toMatchObject({ used: 3, remaining: 7 });
    expect(r.stock[0]).toMatchObject({ used: 3, onHand: 7 });
  });

  it('isolates sizes', () => {
    const cs = [...changes(3, '2', 'wet', 's2-'), ...changes(2, '3', 'dirty', 's3-')];
    const r = computeCosts(
      cs,
      [pack('p2', '2026-09-01', 10, 1000, '2'), pack('p3', '2026-09-01', 10, 3000, '3')],
      ['1', '2', '3'],
    );
    expect(r.costs['s2-0']).toMatchObject({ purchaseId: 'p2', costMinor: 100 });
    expect(r.costs['s3-1']).toMatchObject({ purchaseId: 'p3', costMinor: 300 });
    expect(r.packs.p2.used).toBe(3);
    expect(r.packs.p3.used).toBe(2);
    expect(r.stock).toEqual([
      { size: '1', bought: 0, used: 0, onHand: 0 },
      { size: '2', bought: 10, used: 3, onHand: 7 },
      { size: '3', bought: 10, used: 2, onHand: 8 },
    ]);
  });

  it('overflow uses the most recent pack of the same size, estimated', () => {
    const cs = changes(4);
    const r = computeCosts(cs, [pack('new', '2026-09-05', 1, 700), pack('old', '2026-09-01', 1, 500)]);
    expect(r.costs.c0).toMatchObject({ purchaseId: 'old', estimated: false });
    expect(r.costs.c1).toMatchObject({ purchaseId: 'new', estimated: false });
    expect(r.costs.c2).toEqual({ changeId: 'c2', costMinor: 700, purchaseId: null, estimated: true });
    expect(r.stock[0]).toMatchObject({ bought: 2, used: 4, onHand: -2 });
  });

  it('no pack of the size: most recent pack of any size', () => {
    const r = computeCosts(changes(1, '5'), [
      pack('a', '2026-09-03', 10, 2000, '2'),
      pack('b', '2026-09-01', 10, 9000, '3'),
    ]);
    expect(r.costs.c0).toEqual({ changeId: 'c0', costMinor: 200, purchaseId: null, estimated: true });
  });

  it('no packs at all: cost 0, estimated', () => {
    const r = computeCosts(changes(1), [], ['1']);
    expect(r.costs.c0).toEqual({ changeId: 'c0', costMinor: 0, purchaseId: null, estimated: true });
    expect(r.stock).toEqual([
      { size: '1', bought: 0, used: 0, onHand: 0 },
      { size: '3', bought: 0, used: 1, onHand: -1 },
    ]);
  });

  it('orders stock by settings sizes, then other sizes seen', () => {
    const r = computeCosts(
      [change('2026-09-01T00:00:00Z', 'NB')],
      [pack('x', '2026-09-01', 1, 1, '10'), pack('y', '2026-09-01', 1, 1, '2b')],
      ['4', '1'],
    );
    expect(r.stock.map((s) => s.size)).toEqual(['4', '1', '2b', '10', 'NB']);
  });
});
