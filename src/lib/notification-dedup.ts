// Cross-tab notification dedup.
//
// The broker fans a notification out to EVERY WebSocket session a user has, and
// each browser tab runs its own NotificationContext. A per-tab in-memory set
// (the previous design) therefore can't stop the same message popping once per
// tab — it only dedups within a single tab, where duplicates barely occur. We
// back the seen-set with localStorage so all same-origin tabs share it: once any
// tab has alerted for a messageID, the others recognise the duplicate and stay
// quiet.
//
// Semantics: `recordNotification` is called only AFTER a tab actually surfaces
// an alert (see NotificationContext) — never for a suppressed/failed copy — so a
// copy that surfaced nothing still leaves the door open for a retry. Entries age
// out after a window (any redelivery race is far shorter than this) and the map
// is size-capped so storage stays flat.
//
// localStorage can be unavailable or fail mid-session (Safari private mode,
// quota, SSR). We mirror every write into an in-memory map and, on the FIRST
// localStorage error, latch to memory-only so reads and writes can never
// diverge (which would otherwise let a duplicate slip through). Memory-only
// loses the cross-tab property but preserves correct single-tab dedup.

const STORAGE_KEY = 'ex.notif.seen.v1';
const DEDUP_WINDOW_MS = 5 * 60_000; // 5 minutes — well past any fan-out/redelivery race
const MAX_ENTRIES = 500;

type SeenMap = Record<string, number>; // messageID -> epoch ms first alerted

let memoryMap: SeenMap = {};
let lsBroken = false; // latches true the first time localStorage throws

function lsAvailable(): boolean {
  return !lsBroken && typeof window !== 'undefined';
}

function readMap(): SeenMap {
  if (!lsAvailable()) return memoryMap;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SeenMap;
    return {};
  } catch {
    // localStorage access or parse failed — latch to memory and never look back.
    lsBroken = true;
    return memoryMap;
  }
}

function writeMap(map: SeenMap): void {
  memoryMap = map; // always mirror so a later localStorage failure keeps recent data
  if (!lsAvailable()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    lsBroken = true;
  }
}

// prune drops expired entries and, if still over the cap, the oldest ones.
function prune(map: SeenMap, now: number): SeenMap {
  const live = Object.entries(map).filter(([, ts]) => now - ts < DEDUP_WINDOW_MS);
  if (live.length > MAX_ENTRIES) {
    live.sort((a, b) => a[1] - b[1]); // oldest first
    live.splice(0, live.length - MAX_ENTRIES);
  }
  return Object.fromEntries(live);
}

// hasSeenNotification reports whether messageID was already alerted (by this tab
// or any other same-origin tab) within the dedup window.
export function hasSeenNotification(messageID: string, now: number): boolean {
  const ts = readMap()[messageID];
  return ts !== undefined && now - ts < DEDUP_WINDOW_MS;
}

// recordNotification marks messageID as alerted now, shared across tabs.
export function recordNotification(messageID: string, now: number): void {
  const map = readMap();
  map[messageID] = now;
  writeMap(prune(map, now));
}

// resetNotificationDedup clears all state (shared, in-memory, and the broken
// latch). Test-only.
export function resetNotificationDedup(): void {
  memoryMap = {};
  lsBroken = false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
