// Purchases (Kaup): pack list with price per diaper and remaining count; add/edit/delete.
import { useState } from 'preact/hooks';
import type { AppState, Purchase } from '../../../shared/types';
import { confirmDialog, enqueue, pendingIds, t, useStore } from '../store';
import { fmtDate, fmtMoney, localDate, minorToInput, parseMoneyToMinor, uuid } from '../util';
import { Choice, Field, Modal } from './ui';

export function Purchases(props: { view: AppState }) {
  const s = t();
  const { lang } = useStore();
  const { purchases, packs, settings } = props.view;
  const [editing, setEditing] = useState<Purchase | 'new' | null>(null);
  const pending = pendingIds();

  return (
    <div class="screen">
      <button type="button" class="btn primary big full" onClick={() => setEditing('new')}>
        + {s.addPurchase}
      </button>

      <section class="card">
        <h2>{s.purchasesTitle}</h2>
        {purchases.length === 0 ? (
          <p class="muted">{s.noPurchases}</p>
        ) : (
          <ul class="list">
            {purchases.map((p) => {
              const pack = pending.has(p.id) ? undefined : packs[p.id];
              const perDiaper = pack ? pack.perDiaperMinor : p.count > 0 ? p.priceMinor / p.count : 0;
              const remaining = pack ? pack.remaining : null;
              return (
                <li key={p.id}>
                  <button type="button" class="list-row purchase" onClick={() => setEditing(p)}>
                    <span class="size-badge">{p.size}</span>
                    <span class="grow">
                      <span class="strong">{p.brand || '—'}</span>
                      <span class="sub">
                        {fmtDate(p.date, lang)} · {p.count} {s.pcs}
                        {p.store ? ` · ${p.store}` : ''} · {p.loggedBy}
                      </span>
                    </span>
                    <span class="amount right">
                      <span class="strong">{fmtMoney(p.priceMinor, settings)}</span>
                      <span class="sub">
                        {fmtMoney(perDiaper, settings)} {s.perDiaper}
                      </span>
                      <span class={remaining !== null && remaining <= 0 ? 'sub' : 'sub accent'}>
                        {s.remaining}: {remaining === null ? '⟳' : `${remaining}/${p.count}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {editing && (
        <PurchaseForm
          purchase={editing === 'new' ? null : editing}
          view={props.view}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function PurchaseForm(props: { purchase: Purchase | null; view: AppState; onClose: () => void }) {
  const s = t();
  const { parentName, lastSize } = useStore();
  const p = props.purchase;
  const settings = props.view.settings;
  const baseSizes = settings.sizes.length ? settings.sizes : ['1'];
  const sizes = p && !baseSizes.includes(p.size) ? [...baseSizes, p.size] : baseSizes;

  const [date, setDate] = useState(p?.date ?? localDate());
  const [size, setSize] = useState(p?.size ?? (baseSizes.includes(lastSize) ? lastSize : baseSizes[0]));
  const [brand, setBrand] = useState(p?.brand ?? '');
  const [store, setStore] = useState(p?.store ?? '');
  const [count, setCount] = useState(p ? String(p.count) : '');
  const [price, setPrice] = useState(p ? minorToInput(p.priceMinor) : '');
  const [error, setError] = useState('');

  const save = (e: Event) => {
    e.preventDefault();
    const n = Number(count);
    if (!Number.isInteger(n) || n <= 0) return setError(s.invalidCount);
    const priceMinor = parseMoneyToMinor(price);
    if (priceMinor === null) return setError(s.invalidPrice);
    const purchase: Purchase = {
      id: p?.id ?? uuid(),
      date,
      size,
      brand: brand.trim() || null,
      count: n,
      priceMinor,
      store: store.trim() || null,
      loggedBy: p?.loggedBy ?? parentName,
    };
    enqueue({ kind: 'putPurchase', purchase });
    props.onClose();
  };

  const remove = async () => {
    if (!p || !(await confirmDialog(s.confirmDeletePurchase))) return;
    enqueue({ kind: 'deletePurchase', id: p.id });
    props.onClose();
  };

  const priceMinor = parseMoneyToMinor(price);
  const n = Number(count);
  const preview = priceMinor !== null && Number.isInteger(n) && n > 0 ? priceMinor / n : null;

  return (
    <Modal title={p ? s.editPurchase : s.addPurchase} onClose={props.onClose}>
      <form class="stack" onSubmit={save}>
        <Field label={s.date}>
          <input
            type="date"
            class="text-input"
            value={date}
            required
            onInput={(e) => setDate(e.currentTarget.value)}
          />
        </Field>
        <div class="field">
          <span class="field-label">{s.size}</span>
          <Choice options={sizes} value={size} onChange={setSize} />
        </div>
        <Field label={s.brand}>
          <input
            type="text"
            class="text-input"
            value={brand}
            maxLength={60}
            onInput={(e) => setBrand(e.currentTarget.value)}
          />
        </Field>
        <div class="row gap">
          <Field label={s.count}>
            <input
              type="text"
              class="text-input"
              inputMode="numeric"
              pattern="[0-9]*"
              value={count}
              required
              onInput={(e) => setCount(e.currentTarget.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field label={`${s.price} (${settings.currencySymbol || settings.currency})`}>
            <input
              type="text"
              class="text-input"
              inputMode="decimal"
              value={price}
              required
              onInput={(e) => setPrice(e.currentTarget.value)}
            />
          </Field>
        </div>
        {preview !== null && (
          <p class="muted small">
            = {fmtMoney(preview, settings)} {s.perDiaper}
          </p>
        )}
        <Field label={s.store}>
          <input
            type="text"
            class="text-input"
            value={store}
            maxLength={60}
            onInput={(e) => setStore(e.currentTarget.value)}
          />
        </Field>
        {error && <p class="error">{error}</p>}
        <div class="row gap">
          {p && (
            <button type="button" class="btn danger" onClick={remove}>
              {s.delete}
            </button>
          )}
          <button type="submit" class="btn primary grow">
            {s.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
