// Interaction feedback: tap ripple + emoji pop on every button, confetti on
// milestones, and short vibrations where the Vibration API exists (Android;
// iOS Safari has none, so it is silently skipped). Everything honours
// prefers-reduced-motion and adds no dependencies.

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Short vibration; a no-op where unsupported. */
export function haptic(pattern: number | number[] = 10): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}

const POP_EMOJIS = ['✨', '💛', '👶', '🍼', '⭐', '🧸', '🎈'];

/** Floating emoji that rises and fades from (x, y). */
export function popEmoji(x: number, y: number, emoji?: string): void {
  if (reducedMotion()) return;
  const el = document.createElement('span');
  el.className = 'fx-pop';
  el.textContent = emoji ?? POP_EMOJIS[Math.floor(Math.random() * POP_EMOJIS.length)];
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 50)}px`);
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function ripple(target: HTMLElement, x: number, y: number): void {
  if (reducedMotion()) return;
  const r = target.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const el = document.createElement('span');
  el.className = 'fx-ripple';
  el.style.width = el.style.height = `${size}px`;
  el.style.left = `${x - r.left - size / 2}px`;
  el.style.top = `${y - r.top - size / 2}px`;
  el.setAttribute('aria-hidden', 'true');
  target.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

const TAPPABLE = 'button, .btn, a[href], [role="button"], input[type="checkbox"], input[type="radio"], select';

/**
 * Installs one delegated listener for the whole app: every tap on a control
 * gets a ripple, a light tick and a small emoji pop. Controls can pick their
 * own emoji with `data-pop="💧"`, or opt out with `data-pop=""`.
 */
export function installTapFeedback(): () => void {
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = (e.target as Element | null)?.closest<HTMLElement>(TAPPABLE);
    if (!target || (target as HTMLButtonElement).disabled) return;
    haptic(8);
    if (target.tagName === 'BUTTON' || target.classList.contains('btn')) {
      target.classList.add('fx-host');
      ripple(target, e.clientX, e.clientY);
    }
    const pop = target.dataset.pop;
    if (pop !== '') popEmoji(e.clientX, e.clientY, pop);
  };
  document.addEventListener('pointerdown', onDown, { passive: true });
  return () => document.removeEventListener('pointerdown', onDown);
}

// ---------- confetti ----------

const COLORS = ['#4fb5b0', '#4a90d9', '#7b61c4', '#f0b44c', '#ef6b61', '#6fd0cb', '#ffd166'];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
}

/** Confetti burst from the centre of the screen, plus a celebratory buzz. */
export function confetti(count = 140): void {
  haptic([30, 60, 30, 60, 80]);
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  const cx = W / 2;
  const cy = H / 2;
  const pieces: Piece[] = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 9;
    return {
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  });

  const start = performance.now();
  const DURATION = 2600;
  let last = start;
  const frame = (now: number) => {
    const dt = Math.min(2, (now - last) / 16.7);
    last = now;
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = t > DURATION - 600 ? Math.max(0, (DURATION - t) / 600) : 1;
    for (const p of pieces) {
      p.vy += 0.25 * dt;
      p.vx *= 0.99;
      p.vy *= 0.99;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)));
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// ---------- milestones ----------

/** Total-diaper counts worth celebrating: 1, 10, 50, 100, 250, 500, 750, 1000, then every 500. */
export function isMilestone(total: number): boolean {
  if ([1, 10, 50, 100, 250, 500, 750].includes(total)) return true;
  return total >= 1000 && total % 500 === 0;
}
