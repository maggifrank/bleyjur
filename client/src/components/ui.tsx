// Shared UI pieces: modal, confirm dialog, toast, sync indicator, tab bar.
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { hideToast, sync, t, useStore } from '../store';

export function Modal(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="sheet-head">
          <h2>{props.title}</h2>
          <button type="button" class="icon-btn" aria-label={t().cancel} onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function ConfirmHost() {
  const { confirm } = useStore();
  if (!confirm) return null;
  const s = t();
  return (
    <div class="backdrop center" onClick={(e) => e.target === e.currentTarget && confirm.resolve(false)}>
      <div class="dialog" role="alertdialog" aria-modal="true">
        <p>{confirm.text}</p>
        <div class="row gap">
          <button type="button" class="btn secondary grow" onClick={() => confirm.resolve(false)}>
            {s.no}
          </button>
          <button type="button" class="btn danger grow" onClick={() => confirm.resolve(true)}>
            {s.yes}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ToastHost() {
  const { toast } = useStore();
  if (!toast) return null;
  return (
    <div class="toast" role="status" key={toast.id}>
      <span class="grow">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          class="toast-action"
          onClick={() => {
            const run = toast.action!.run;
            hideToast();
            run();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function SyncIndicator() {
  const { queue, online } = useStore();
  const s = t();
  if (queue.length > 0) {
    return (
      <button type="button" class="pill warn" onClick={() => void sync()}>
        ⟳ {s.notSynced(queue.length)}
      </button>
    );
  }
  if (!online) return <span class="pill muted">{s.offline}</span>;
  return null;
}

export type Tab = 'log' | 'dashboard' | 'purchases' | 'settings';

const ICONS: Record<Tab, ComponentChildren> = {
  log: <path d="M12 5v14M5 12h14" />,
  dashboard: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  purchases: (
    <>
      <path d="M6 7h12l-1 13H7L6 7z" />
      <path d="M9 7a3 3 0 0 1 6 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </>
  ),
};

export function TabBar(props: { tab: Tab; onTab: (t: Tab) => void }) {
  const s = t();
  const labels: Record<Tab, string> = {
    log: s.tabLog,
    dashboard: s.tabDashboard,
    purchases: s.tabPurchases,
    settings: s.tabSettings,
  };
  return (
    <nav class="tabbar">
      {(Object.keys(labels) as Tab[]).map((k) => (
        <button
          type="button"
          key={k}
          class={k === props.tab ? 'tab active' : 'tab'}
          aria-current={k === props.tab ? 'page' : undefined}
          onClick={() => props.onTab(k)}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            {ICONS[k]}
          </svg>
          <span>{labels[k]}</span>
        </button>
      ))}
    </nav>
  );
}

/** A labelled form field. */
export function Field(props: { label: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      {props.children}
    </label>
  );
}

/** Horizontal row of selectable chips (sizes, types). */
export function Choice<T extends string>(props: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  label?: (v: T) => string;
  big?: boolean;
}) {
  return (
    <div class={props.big ? 'choices big' : 'choices'} role="radiogroup">
      {props.options.map((o) => (
        <button
          type="button"
          key={o}
          role="radio"
          aria-checked={o === props.value}
          class={o === props.value ? 'chip on' : 'chip'}
          onClick={() => props.onChange(o)}
        >
          {props.label ? props.label(o) : o}
        </button>
      ))}
    </div>
  );
}
