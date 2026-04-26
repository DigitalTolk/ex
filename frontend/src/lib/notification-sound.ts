// Lightweight Web Audio "ping" used for in-app notification alerts. We
// generate the tone instead of shipping an audio asset so the feature works
// across browsers with no extra HTTP round-trip and no codec concerns.
//
// Single shared AudioContext, lazily created on first user gesture (most
// browsers reject AudioContext.resume() unless triggered by user input).

let ctx: AudioContext | null = null;

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

export function playNotificationPing(): void {
  const c = ensureContext();
  if (!c) return;
  // If the context was suspended by the browser autoplay policy, kick it.
  // resume() returns a Promise we don't await — the worst case is one
  // dropped tone, which is preferable to logging spam.
  if (c.state === 'suspended') {
    void c.resume();
  }
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
