// Log screen: size selector, one-tap change buttons, today's changes.
import { useState } from 'preact/hooks';
import { CHANGE_TYPES, type AppState, type Change, type ChangeType } from '../../../shared/types';
import {
  confirmDialog,
  enqueue,
  pendingIds,
  setLastSize,
  showToast,
  t,
  unqueuePut,
  useStore,
} from '../store';
import { confetti, haptic, isMilestone, popEmoji } from '../fx';
import { fmtMoney, fmtTime, fromDateTimeLocal, localDate, toDateTimeLocal, uuid } from '../util';
import { Choice, Field, Modal } from './ui';
import { WeeklyCard, shouldShowWeekly } from './Weekly';

/** Emoji that floats up from a log button when tapped. */
const POP: Record<ChangeType, string> = { wet: '💧', dirty: '💩', both: '💩', dry: '✨' };

export function LogScreen(props: { view: AppState }) {
  const { lastSize, parentName, reports } = useStore();
  const s = t();
  const { settings, changes } = props.view;
  const [editing, setEditing] = useState<Change | null>(null);

  const sizes = settings.sizes.length ? settings.sizes : ['1'];
  const size = sizes.includes(lastSize) ? lastSize : (changes[0]?.size && sizes.includes(changes[0].size) ? changes[0].size : sizes[0]);

  const log = (type: ChangeType, e: MouseEvent) => {
    const change: Change = {
      id: uuid(),
      time: new Date().toISOString(),
      size,
      type,
      note: null,
      loggedBy: parentName,
    };
    setLastSize(size);
    enqueue({ kind: 'putChange', change });
    const total = changes.length + 1;
    const milestone = isMilestone(total);
    const emoji = POP[type];
    for (let i = 0; i < 2; i++) setTimeout(() => popEmoji(e.clientX, e.clientY, emoji), 90 * (i + 1));
    if (milestone) confetti();
    else haptic(20);
    const text = s.logged(s.types[type], size);
    showToast(milestone ? `${s.milestone(total)} ${text}` : text, {
      label: s.undo,
      run: () => {
        if (!unqueuePut(change.id)) enqueue({ kind: 'deleteChange', id: change.id });
        showToast(s.undone, undefined, 2000);
      },
    });
  };

  const today = localDate();
  const todays = changes.filter((c) => localDate(new Date(c.time)) === today);

  return (
    <div class="screen">
      {reports && shouldShowWeekly(reports) && <WeeklyCard reports={reports} settings={settings} dismissible />}

      <section class="card">
        <h2>{s.logTitle}</h2>
        <div class="label-row">{s.size}</div>
        <Choice options={sizes} value={size} onChange={setLastSize} big />
        <div class="log-grid">
          {CHANGE_TYPES.map((type) => (
            <button type="button" key={type} class={`log-btn t-${type}`} data-pop={POP[type]} onClick={(e) => log(type, e)}>
              <span class="log-icon">{s.types[type]}</span>
            </button>
          ))}
        </div>
      </section>

      <section class="card">
        <h2>
          {s.todayChanges} <span class="count">{todays.length}</span>
        </h2>
        {todays.length === 0 ? (
          <p class="muted">{s.noChangesToday}</p>
        ) : (
          <ChangeList changes={todays} view={props.view} onEdit={setEditing} />
        )}
      </section>

      {editing && <ChangeEditor change={editing} view={props.view} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ChangeList(props: { changes: Change[]; view: AppState; onEdit: (c: Change) => void }) {
  const s = t();
  const pending = pendingIds();
  const { costs, settings } = props.view;
  return (
    <ul class="list">
      {props.changes.map((c) => {
        const cost = costs[c.id];
        const isPending = pending.has(c.id);
        return (
          <li key={c.id}>
            <button type="button" class="list-row" onClick={() => props.onEdit(c)}>
              <span class="time">{fmtTime(c.time)}</span>
              <span class="size-badge">{c.size}</span>
              <span class="grow">
                {s.types[c.type]}
                {c.note && <span class="note"> · {c.note}</span>}
                <span class="sub">{c.loggedBy}</span>
              </span>
              <span class="amount">
                {isPending || !cost ? (
                  <span class="muted" title={s.notSynced(1)}>
                    ⟳
                  </span>
                ) : (
                  `${cost.estimated ? '≈ ' : ''}${fmtMoney(cost.costMinor, settings)}`
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ChangeEditor(props: { change: Change; view: AppState; onClose: () => void }) {
  const s = t();
  const c = props.change;
  const [time, setTime] = useState(toDateTimeLocal(c.time));
  const [size, setSize] = useState(c.size);
  const [type, setType] = useState<ChangeType>(c.type);
  const [note, setNote] = useState(c.note ?? '');
  const sizes = props.view.settings.sizes.includes(c.size)
    ? props.view.settings.sizes
    : [...props.view.settings.sizes, c.size];
  const iso = fromDateTimeLocal(time);

  const save = (e: Event) => {
    e.preventDefault();
    if (!iso) return;
    enqueue({
      kind: 'putChange',
      change: { ...c, time: iso, size, type, note: note.trim() || null },
    });
    props.onClose();
  };

  const remove = async () => {
    if (!(await confirmDialog(s.confirmDeleteChange))) return;
    enqueue({ kind: 'deleteChange', id: c.id });
    props.onClose();
  };

  return (
    <Modal title={s.editChange} onClose={props.onClose}>
      <form class="stack" onSubmit={save}>
        <Field label={s.time}>
          <input
            type="datetime-local"
            class="text-input"
            value={time}
            required
            onInput={(e) => setTime(e.currentTarget.value)}
          />
        </Field>
        <div class="field">
          <span class="field-label">{s.size}</span>
          <Choice options={sizes} value={size} onChange={setSize} />
        </div>
        <div class="field">
          <span class="field-label">{s.type}</span>
          <Choice options={CHANGE_TYPES} value={type} onChange={setType} label={(v) => s.types[v]} />
        </div>
        <Field label={s.note}>
          <input
            type="text"
            class="text-input"
            value={note}
            maxLength={200}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
        </Field>
        <p class="muted small">{c.loggedBy}</p>
        <div class="row gap">
          <button type="button" class="btn danger" onClick={remove}>
            {s.delete}
          </button>
          <button type="submit" class="btn primary grow" disabled={!iso}>
            {s.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
