// PIN login and first-run parent name screens.
import { useEffect, useState } from 'preact/hooks';
import { login, setParentName, t } from '../store';

export function Login() {
  const s = t();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  const waiting = waitUntil > now;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!pin || busy || waiting) return;
    setBusy(true);
    setError('');
    const r = await login(pin);
    setBusy(false);
    if (r.ok) return;
    setPin('');
    if (r.reason === 'wrong') setError(s.loginWrong);
    else if (r.reason === 'rate') {
      setWaitUntil(Date.now() + (r.retryAfter ?? 60) * 1000);
      setNow(Date.now());
    } else if (r.reason === 'offline') setError(s.loginOffline);
    else setError(s.loginError);
  };

  const secondsLeft = Math.ceil((waitUntil - now) / 1000);

  return (
    <main class="center-screen">
      <img src="/icon.svg" alt="" width="96" height="96" class="logo" />
      <h1>{s.loginTitle}</h1>
      <form onSubmit={submit} class="stack login-form">
        <input
          class="pin-input"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autocomplete="current-password"
          aria-label={s.loginPin}
          placeholder="••••"
          value={pin}
          autoFocus
          onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
        />
        <button type="submit" class="btn primary big" disabled={!pin || busy || waiting}>
          {s.loginButton}
        </button>
        {waiting && <p class="error">{s.loginRateLimited(secondsLeft)}</p>}
        {!waiting && error && <p class="error">{error}</p>}
      </form>
    </main>
  );
}

export function FirstRun() {
  const s = t();
  const [name, setName] = useState('');
  return (
    <main class="center-screen">
      <img src="/icon.svg" alt="" width="96" height="96" class="logo" />
      <h1>{s.firstRunTitle}</h1>
      <p class="muted">{s.firstRunText}</p>
      <form
        class="stack login-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) setParentName(name);
        }}
      >
        <input
          type="text"
          class="text-input big"
          placeholder={s.firstRunPlaceholder}
          value={name}
          autoFocus
          maxLength={40}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <button type="submit" class="btn primary big" disabled={!name.trim()}>
          {s.continue}
        </button>
      </form>
    </main>
  );
}
