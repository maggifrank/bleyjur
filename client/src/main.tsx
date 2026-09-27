import { render } from 'preact';
import { App } from './app';
import { loadLang } from './i18n';
import './styles.css';

document.documentElement.lang = loadLang();

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW needs a secure context (localhost or https); on plain http LAN it is unavailable. */
    });
  });
}
