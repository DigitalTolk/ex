// Lightweight Web Audio "ping" used for in-app notification alerts. We
// generate the tone instead of shipping an audio asset so the feature works
// across browsers with no extra HTTP round-trip and no codec concerns.
//
// Single shared AudioContext, lazily created on first user gesture (most
// browsers reject AudioContext.resume() unless triggered by user input).

let ctx: AudioContext | null = null;
let unlockListenersInstalled = false;
let resumeInFlight: Promise<void> | null = null;
let pendingPing = false;

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

// scheduleTone wires the oscillator + envelope onto a *running*
// AudioContext. Scheduling onto a suspended context drops the tone:
// the start time sits at currentTime=0 while the clock is paused, and
// once the clock advances the scheduled time is already in the past.
function scheduleTone(c: AudioContext): void {
  const now = c.currentTime;

  // Two-tone "subtle" ping: short rise from 660Hz to 880Hz with an
  // exponential decay envelope so it doesn't sound like a system error.
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(660, now);
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

  osc.connect(gain).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.4);
}

function schedulePendingTone(c: AudioContext): void {
  if (!pendingPing) return;
  pendingPing = false;
  scheduleTone(c);
}

function resumeThenMaybePlay(c: AudioContext): void {
  if (c.state !== 'suspended') {
    schedulePendingTone(c);
    return;
  }
  if (!resumeInFlight) {
    resumeInFlight = c.resume().then(
      () => schedulePendingTone(c),
      () => undefined,
    ).finally(() => {
      resumeInFlight = null;
    });
  }
}

function unlockAudioContext(): void {
  const c = ensureContext();
  if (!c) return;
  resumeThenMaybePlay(c);
}

function installUnlockListeners(): void {
  if (unlockListenersInstalled || typeof window === 'undefined') return;
  unlockListenersInstalled = true;
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener('pointerdown', unlockAudioContext, opts);
  window.addEventListener('keydown', unlockAudioContext, opts);
  window.addEventListener('touchstart', unlockAudioContext, opts);
}

installUnlockListeners();

export function playNotificationPing(): void {
  installUnlockListeners();
  const c = ensureContext();
  if (!c) return;
  // Suspended context (browser autoplay policy / fresh ctx pre-gesture)
  // must finish resume() before we can schedule — see scheduleTone.
  if (c.state === 'suspended') {
    pendingPing = true;
    resumeThenMaybePlay(c);
    return;
  }
  scheduleTone(c);
}
