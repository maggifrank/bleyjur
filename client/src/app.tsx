// Root component: auth gate, first-run, header, screens and tab bar.
import { useEffect, useState } from 'preact/hooks';
import { Dashboard } from './components/Dashboard';
import { FirstRun, Login } from './components/Login';
import { LogScreen } from './components/LogScreen';
import { Purchases } from './components/Purchases';
import { SettingsScreen } from './components/SettingsScreen';
import { ConfirmHost, SyncIndicator, TabBar, ToastHost, type Tab } from './components/ui';
import { checkSession, currentView, startSyncLoop, t, useStore } from './store';

const TAB_KEY = 'bleyjur.tab';

function initialTab(): Tab {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    if (v === 'log' || v === 'dashboard' || v === 'purchases' || v === 'settings') return v;
  } catch {
    /* ignore */
  }
  return 'log';
}

export function App() {
  const st = useStore();
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    void checkSession();
    return startSyncLoop();
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
    window.scrollTo(0, 0);
  }, [tab]);

  const s = t();
  let body;
  if (st.auth === 'checking') {
    body = (
      <main class="center-screen">
        <img src="/icon.svg" alt="" width="96" height="96" class="logo" />
      </main>
    );
  } else if (st.auth === 'login') {
    body = <Login />;
  } else if (!st.parentName) {
    body = <FirstRun />;
  } else {
    const view = currentView();
    const title = tab === 'log' ? view?.settings.babyName || s.appName : titleFor(tab);
    body = (
      <>
        <header class="topbar">
          <h1>{title}</h1>
          <SyncIndicator />
        </header>
        <main class="content">
          {!view ? (
            <p class="muted center">{st.online ? s.loading : s.loginOffline}</p>
          ) : tab === 'log' ? (
            <LogScreen view={view} />
          ) : tab === 'dashboard' ? (
            <Dashboard view={view} />
          ) : tab === 'purchases' ? (
            <Purchases view={view} />
          ) : (
            <SettingsScreen view={view} />
          )}
        </main>
        <TabBar tab={tab} onTab={setTab} />
      </>
    );
  }

  return (
    <>
      {body}
      <ToastHost />
      <ConfirmHost />
    </>
  );
}

function titleFor(tab: Tab): string {
  const s = t();
  switch (tab) {
    case 'dashboard':
      return s.dashboardTitle;
    case 'purchases':
      return s.purchasesTitle;
    case 'settings':
      return s.settingsTitle;
    default:
      return s.appName;
  }
}
