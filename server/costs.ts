// Pure FIFO cost calculation. No DB access.
import type { Change, ChangeCost, PackStatus, Purchase, StockBySize } from '../shared/types.js';

export interface CostResult {
  costs: Record<string, ChangeCost>;
  packs: Record<string, PackStatus>;
  stock: StockBySize[];
}

const perDiaper = (p: Purchase): number => (p.count > 0 ? p.priceMinor / p.count : 0);

/** Stable sort by date asc; ties keep input (insertion) order. */
function sortPacks(purchases: Purchase[]): Purchase[] {
  return purchases
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.date < b.p.date ? -1 : a.p.date > b.p.date ? 1 : a.i - b.i))
    .map((x) => x.p);
}

function sortChanges(changes: Change[]): Change[] {
  return changes
    .map((c, i) => ({ c, i, t: Date.parse(c.time) }))
    .sort((a, b) => a.t - b.t || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : a.i - b.i))
    .map((x) => x.c);
}

/**
 * Assign every change a cost by consuming one diaper from the oldest pack of
 * the same size that still has diapers left.
 *
 * @param purchases in insertion order (used to break ties between same-date packs)
 * @param sizeOrder settings.sizes, for ordering the stock list
 */
export function computeCosts(changes: Change[], purchases: Purchase[], sizeOrder: string[] = []): CostResult {
  const packsSorted = sortPacks(purchases);
  const packs: Record<string, PackStatus> = {};
  const bySize = new Map<string, Purchase[]>();
  for (const p of packsSorted) {
    packs[p.id] = { purchaseId: p.id, perDiaperMinor: perDiaper(p), used: 0, remaining: p.count };
    const list = bySize.get(p.size) ?? [];
    list.push(p);
    bySize.set(p.size, list);
  }
  // Most recent = last in the sorted order (latest date, latest insertion).
  const mostRecentAny = packsSorted[packsSorted.length - 1];

  const costs: Record<string, ChangeCost> = {};
  const cursor = new Map<string, number>(); // index of oldest pack with diapers left, per size
  const used = new Map<string, number>();

  for (const c of sortChanges(changes)) {
    used.set(c.size, (used.get(c.size) ?? 0) + 1);
    const list = bySize.get(c.size) ?? [];
    let i = cursor.get(c.size) ?? 0;
    while (i < list.length && packs[list[i].id].remaining <= 0) i++;
    cursor.set(c.size, i);

    if (i < list.length) {
      const pack = list[i];
      const st = packs[pack.id];
      st.used++;
      st.remaining--;
      costs[c.id] = { changeId: c.id, costMinor: st.perDiaperMinor, purchaseId: pack.id, estimated: false };
    } else {
      const fallback = list.length > 0 ? list[list.length - 1] : mostRecentAny;
      costs[c.id] = {
        changeId: c.id,
        costMinor: fallback ? perDiaper(fallback) : 0,
        purchaseId: null,
        estimated: true,
      };
    }
  }

  const bought = new Map<string, number>();
  for (const p of purchases) bought.set(p.size, (bought.get(p.size) ?? 0) + p.count);

  const known = new Set(sizeOrder);
  const others = [...new Set([...bought.keys(), ...used.keys()])]
    .filter((s) => !known.has(s))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const stock: StockBySize[] = [...sizeOrder, ...others].map((size) => {
    const b = bought.get(size) ?? 0;
    const u = used.get(size) ?? 0;
    return { size, bought: b, used: u, onHand: b - u };
  });

  return { costs, packs, stock };
}
