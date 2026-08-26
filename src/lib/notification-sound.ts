// Lightweight Web Audio "ping" used for in-app notification alerts. We
// generate the tone instead of shipping an audio asset so the feature works
// across browsers with no extra HTTP round-trip and no codec concerns.
//
// Single shared AudioContext, lazily created on first user gesture (most
// browsers reject AudioContext.resume() unless triggered by user input).

// Which alert the tone represents. Approvals BLOCK an agent run until the user
// answers, so they get their own shape — recognisable without looking at the
// screen and without reading the banner.
export type AlertTone = 'message' | 'approval';

let ctx: AudioContext | null = null;
let unlockListenersInstalled = false;
let resumeInFlight: Promise<void> | null = null;
// Which tone (if any) is queued waiting for the context to resume. Was a
// boolean; it has to carry the KIND or a sound queued before the first user
// gesture would play back as the wrong alert.
let pendingTone: AlertTone | null = null;

function ensureContext(): AudioContext | null {
  /* istanbul ignore next -- SSR guard: window is always defined in the browser test environment; reachable only under a Node render we don't do. */
  if (typeof window === 'undefined') return null;
  if (ctx && ctx.state !== 'closed') return ctx;
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
function scheduleTone(c: AudioContext, kind: AlertTone = 'message'): void {
  const now = c.currentTime;
  if (kind === 'approval') {
    scheduleApprovalTone(c, now);
    return;
  }

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

// The approval chime: two deliberate rising notes rather than one soft rise.
// Distinct by RHYTHM (two pulses) as well as pitch, which is what makes it
// tellable apart from the message ping in a noisy room. Kept at the same peak
// gain so it is attention-getting without being louder.
function scheduleApprovalTone(c: AudioContext, now: number): void {
  const notes = [
    { at: 0, freq: 784 }, // G5
    { at: 0.16, freq: 1046 }, // C6 — the rise says "your turn"
  ];
  for (const n of notes) {
    const start = now + n.at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(n.freq, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);

    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.22);
  }
}

function schedulePendingTone(c: AudioContext): void {
  if (!pendingTone) return;
  const kind = pendingTone;
  pendingTone = null;
  scheduleTone(c, kind);
}

function resumeThenMaybePlay(c: AudioContext): void {
  if (c.state === 'running') {
    schedulePendingTone(c);
    return;
  }
  /* istanbul ignore next -- a closed AudioContext state cannot be produced headless: the test environment never closes the shared context, and ensureContext() recreates it; both this `closed` arm and the inner `if (next)` recursion are defensive against a browser tearing the context down mid-session. */
  if (c.state === 'closed') {
    ctx = null;
    const next = ensureContext();
    if (next) resumeThenMaybePlay(next);
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

function play(kind: AlertTone): void {
  installUnlockListeners();
  const c = ensureContext();
  if (!c) return;
  // Suspended/interrupted contexts (browser autoplay policy, fresh ctx
  // pre-gesture, or Safari temporarily interrupting audio) must finish
  // resume() before we can schedule — see scheduleTone.
  if (c.state !== 'running') {
    pendingTone = kind;
    resumeThenMaybePlay(c);
    return;
  }
  scheduleTone(c, kind);
}

export function playNotificationPing(): void {
  play('message');
}

// playApprovalChime is the sound for a run blocked on the user's decision.
export function playApprovalChime(): void {
  play('approval');
}
