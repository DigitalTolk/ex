// Bridge to the desktop shell's native Do-Not-Disturb / Focus query
// (`window.__EX_DND__`, see types/global.d.ts). The web platform cannot ask
// the OS whether Focus/DnD is active, so without this bridge the app must
// delegate notification sound to the OS notification itself; with it, the
// app can play its custom ping and still go quiet under Focus —
// Slack/Mattermost-style.

export function hasDndBridge(): boolean {
  return typeof window.__EX_DND__ === 'function';
}

// isDndActive resolves the shell-reported Focus/DnD state. A missing or
// broken bridge resolves false — fail toward the audible alert: an extra
// ping is the accepted failure direction, a silently swallowed alert is not.
export async function isDndActive(): Promise<boolean> {
  const query = window.__EX_DND__;
  if (typeof query !== 'function') return false;
  try {
    return Boolean(await query());
  } catch {
    return false;
  }
}
