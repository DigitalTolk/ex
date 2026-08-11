// Desktop-shell presence bridge, web side (SPEC §2 R6, layer 1 — the
// strongest signal). The ex-electron shell watches the OS via powerMonitor
// (idle seconds, lock/unlock, suspend/resume) and mirrors the verdict into
// the page through the same world-crossing pattern as the DnD bridge: a
// `data-ex-presence` attribute stamped on <html> plus an `ex:presence-changed`
// DOM event on each transition. No contextBridge — the chat window runs a
// remote SPA, so DOM state is the only shared surface.
//
// Mapping (SPEC R2/R3):
//   locked / suspended / idle → hard-away: the desktop must not ack, the
//     mobile fallback owns the alert (Slack's "1 minute after locking").
//   active → release hard-away AND stamp the activity clock: the shell only
//     reports active while OS-level input is fresh, which is stronger
//     evidence than anything the page can see (it also clears the wake
//     latch after a resume, since unlocking required real input).
//   unsupported / attribute absent / unknown → release: the shell can't
//     vouch either way (e.g. Linux/Wayland), so the web floor governs.
//
// Old shells never stamp the attribute, so this module is inert there (I-12).

import { markUserActivity, setHardAway } from '@/lib/user-activity';

export const PRESENCE_STATE_ATTR = 'data-ex-presence';
export const PRESENCE_CHANGED_EVENT = 'ex:presence-changed';

export type ShellPresenceState = 'active' | 'idle' | 'locked' | 'suspended' | 'unsupported';

const HARD_AWAY_REASON = 'shell';

let installed = false;

function applyShellPresence(): void {
  const state = document.documentElement.getAttribute(PRESENCE_STATE_ATTR);
  switch (state) {
    case 'locked':
    case 'suspended':
    case 'idle':
      setHardAway(HARD_AWAY_REASON, true);
      break;
    case 'active':
      setHardAway(HARD_AWAY_REASON, false);
      markUserActivity();
      break;
    default:
      // 'unsupported', absent, or an unknown future value — the shell has no
      // verdict; never latch away on a broken source (that would spam mobile
      // for a user who IS at the desktop).
      setHardAway(HARD_AWAY_REASON, false);
  }
}

// initDesktopPresence installs the bridge listener once. Outside the desktop
// shell it's a no-op — a plain browser has no shell to listen to.
export function initDesktopPresence(): void {
  if (installed || typeof window === 'undefined' || !window.__EX_DESKTOP__) return;
  installed = true;
  document.addEventListener(PRESENCE_CHANGED_EVENT, applyShellPresence);
  // The shell may have stamped state before the SPA booted.
  applyShellPresence();
}

export function resetDesktopPresenceForTests(): void {
  if (installed) {
    document.removeEventListener(PRESENCE_CHANGED_EVENT, applyShellPresence);
    installed = false;
  }
  document.documentElement.removeAttribute(PRESENCE_STATE_ATTR);
  setHardAway(HARD_AWAY_REASON, false);
}
