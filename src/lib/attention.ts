// Bridge to the desktop shell's "flag this app as needing attention" signal
// (`window.__EX_ATTENTION__`, see types/global.d.ts): a macOS dock bounce or a
// Windows/Linux taskbar flash.
//
// Reserved for a BLOCKED agent run waiting on the user's decision. Ordinary
// messages must never use it — the whole value is that the signal keeps meaning
// "something is waiting on you". The web platform has no equivalent, so in a
// browser tab this is a silent no-op and the banner is the only surface.

export function hasAttentionBridge(): boolean {
  return typeof window.__EX_ATTENTION__ === 'function';
}

// requestOsAttention is fire-and-forget: there is nothing to await and nothing
// to report. A missing bridge or a throwing shell is ignored — failing to
// bounce a dock icon must never break delivering the alert itself.
export function requestOsAttention(): void {
  const ask = window.__EX_ATTENTION__;
  if (typeof ask !== 'function') return;
  try {
    ask();
  } catch {
    // Shell-side failure; the banner/toast has already surfaced.
  }
}
