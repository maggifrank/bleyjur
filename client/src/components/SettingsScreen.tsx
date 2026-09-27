// Settings (Stillingar): device prefs, shared server settings, export/import, logout.
import { useEffect, useState } from 'preact/hooks';
import type { AppState, ExportData, Settings } from '../../../shared/types';
import { LANG_NAMES, type Lang } from '../i18n';
import {
  confirmDialog,
  enqueue,
  importData,
  logout,
  setLang,
  setParentName,
  showToast,
  t,
  useStore,
} from '../store';
import { Choice, Field } from './ui';

export function SettingsScreen(props: { view: AppState }) {
  const s = t();
  const { parentName, lang } = useStore();
  const [name, setName] = useState(parentName);

  return (
    <div class="screen">
      <section class="card stack">
        <h2>{s.thisDevice}</h2>
        <Field label={s.parentName}>
          <input
            type="text"
            class="text-input"
            value={name}
            maxLength={40}
            onInput={(e) => setName(e.currentTarget.value)}
            onBlur={() => name.trim() && name.trim() !== parentName && setParentName(name)}
          />
        </Field>
        <div class="field">
          <span class="field-label">{s.language}</span>
          <Choice<Lang> options={['is', 'en']} value={lang} onChange={setLang} label={(l) => LANG_NAMES[l]} />
        </div>
      </section>

      <SharedSettings settings={props.view.settings} />

      <DataSection />

      <button
        type="button"
        class="btn secondary big full"
        onClick={async () => {
          if (await confirmDialog(s.confirmLogout)) await logout();
        }}
      >
        {s.logout}
      </button>
    </div>
  );
}

function SharedSettings(props: { settings: Settings }) {
  const s = t();
  const [draft, setDraft] = useState<Settings>(props.settings);
  const [newSize, setNewSize] = useState('');
  const serverJson = JSON.stringify(props.settings);
  // Pick up changes from the other parent unless we are mid-edit.
  const [base, setBase] = useState(serverJson);
  useEffect(() => {
    if (serverJson !== base && JSON.stringify(draft) === base) setDraft(props.settings);
    setBase(serverJson);
  }, [serverJson]);

  const dirty = JSON.stringify(draft) !== serverJson;
  const upd = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });

  const addSize = () => {
    const v = newSize.trim();
    if (v && !draft.sizes.includes(v)) upd({ sizes: [...draft.sizes, v] });
    setNewSize('');
  };
  const moveSize = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= draft.sizes.length) return;
    const sizes = [...draft.sizes];
    [sizes[i], sizes[j]] = [sizes[j], sizes[i]];
    upd({ sizes });
  };

  const save = (e: Event) => {
    e.preventDefault();
    if (draft.sizes.length === 0) return;
    enqueue({
      kind: 'putSettings',
      settings: {
        ...draft,
        currency: draft.currency.trim().toUpperCase() || 'ISK',
        currencySymbol: draft.currencySymbol.trim(),
        babyName: draft.babyName.trim(),
      },
    });
    showToast(s.settingsSaved, undefined, 2500);
  };

  return (
    <form class="card stack" onSubmit={save}>
      <h2>{s.shared}</h2>
      <Field label={s.babyName}>
        <input
          type="text"
          class="text-input"
          value={draft.babyName}
          maxLength={40}
          onInput={(e) => upd({ babyName: e.currentTarget.value })}
        />
      </Field>
      <div class="row gap">
        <Field label={s.currency}>
          <input
            type="text"
            class="text-input"
            value={draft.currency}
            maxLength={3}
            autocapitalize="characters"
            onInput={(e) => upd({ currency: e.currentTarget.value.toUpperCase() })}
          />
        </Field>
        <Field label={s.currencySymbol}>
          <input
            type="text"
            class="text-input"
            value={draft.currencySymbol}
            maxLength={6}
            onInput={(e) => upd({ currencySymbol: e.currentTarget.value })}
          />
        </Field>
      </div>
      <Field label={s.weekStart}>
        <select
          class="text-input"
          value={String(draft.weekStart)}
          onChange={(e) => upd({ weekStart: Number(e.currentTarget.value) })}
        >
          {s.weekdays.map((d, i) => (
            <option key={i} value={String(i + 1)}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      <div class="field">
        <span class="field-label">{s.sizes}</span>
        <ul class="size-list">
          {draft.sizes.map((sz, i) => (
            <li key={sz}>
              <span class="size-badge">{sz}</span>
              <span class="grow" />
              <button type="button" class="icon-btn" aria-label="↑" disabled={i === 0} onClick={() => moveSize(i, -1)}>
                ↑
              </button>
              <button
                type="button"
                class="icon-btn"
                aria-label="↓"
                disabled={i === draft.sizes.length - 1}
                onClick={() => moveSize(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                class="icon-btn"
                aria-label={s.delete}
                disabled={draft.sizes.length <= 1}
                onClick={() => upd({ sizes: draft.sizes.filter((x) => x !== sz) })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div class="row gap">
          <input
            type="text"
            class="text-input grow"
            placeholder={s.newSize}
            value={newSize}
            maxLength={10}
            onInput={(e) => setNewSize(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addSize();
              }
            }}
          />
          <button type="button" class="btn secondary" onClick={addSize} disabled={!newSize.trim()}>
            {s.addSize}
          </button>
        </div>
      </div>
      <button type="submit" class="btn primary big" disabled={!dirty}>
        {s.saveSettings}
      </button>
    </form>
  );
}

function DataSection() {
  const s = t();
  const [busy, setBusy] = useState(false);

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let data: ExportData;
    try {
      data = JSON.parse(await file.text()) as ExportData;
      if (!data || typeof data !== 'object' || !Array.isArray(data.changes) || !Array.isArray(data.purchases)) {
        throw new Error('bad file');
      }
    } catch {
      showToast(s.importFailed, undefined, 5000);
      return;
    }
    if (!(await confirmDialog(s.confirmImport))) return;
    setBusy(true);
    const r = await importData(data);
    setBusy(false);
    if (typeof r === 'string') showToast(`${s.importFailed} ${r}`, undefined, 8000);
    else showToast(s.importDone(r.changes, r.purchases), undefined, 5000);
  };

  return (
    <section class="card stack">
      <h2>{s.data}</h2>
      <a class="btn secondary big" href="/api/export" download>
        {s.exportData}
      </a>
      <label class={busy ? 'btn secondary big disabled' : 'btn secondary big'}>
        {s.importData}
        <input type="file" accept="application/json,.json" class="visually-hidden" disabled={busy} onChange={onFile} />
      </label>
    </section>
  );
}
