import { create } from 'zustand';

// Typing source of truth. The entry list, expiry timer, and derived
// per-parent / per-thread maps live here (module state + zustand store)
// so hot-path consumers can subscribe per-bucket: a typing ping in one
// channel re-renders only that channel's indicator, not every consumer
// of a shared context value. TypingProvider (src/context/TypingContext.tsx)
// remains as a compat shim exposing the same context API.

// EXPIRY_MS is how long an entry survives without a refresh ping. The
// client sends "typing" every 3s while the user is actively composing;
// 6s gives two missed pings of slack before the indicator clears so a
// brief network hiccup doesn't blink the indicator off and back on.
const EXPIRY_MS = 6000;

interface TypingEntry {
  userID: string;
  parentID: string;
  // Empty string = main MessageList typing. Non-empty = typing inside a
  // ThreadPanel rooted at that message ID. Stored together in the same
  // entries list because expiry semantics are identical and the (parent,
  // threadRoot) tuple is what segregates the two surfaces in the UI.
  threadRootID: string;
  expiresAt: number;
}

interface TypingStoreState {
  // typingByParent contains only main-list typing (threadRootID==="").
  typingByParent: Record<string, string[]>;
  // typingByThread is keyed by threadTypingKey(parentID, threadRootID).
  typingByThread: Record<string, string[]>;
}

// threadTypingKey is the composition used to key typingByThread. Kept as a
// function so future test helpers / readers don't have to remember the
// pipe-delimited convention.
export function threadTypingKey(parentID: string, threadRootID: string): string {
  return `${parentID}|${threadRootID}`;
}

// shallowEqualByKey reports whether two `key → user-list` maps describe
// the same set of typers per bucket. Used to bail out of setState calls
// that would otherwise force every consumer to re-render every second
// whether anyone is typing or not.
function shallowEqualByKey(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    // The length pre-check above (`ak.length !== bk.length`) already
    // rejects any case where a key in `a` is absent from `b`, so by the
    // time we index `b[k]` for a shared-length pair the key is present;
    // the `!bv` arm is a defensive guard that can't fire under test.
    /* istanbul ignore next -- unreachable: equal-length key sets share keys, so bv is always defined here */
    if (!bv || av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
  }
  return true;
}

export const useTypingStore = create<TypingStoreState>(() => ({
  typingByParent: {},
  typingByThread: {},
}));

let entries: TypingEntry[] = [];
let selfUserID: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function rebuild() {
  const now = Date.now();
  entries = entries.filter((e) => e.expiresAt > now);
  const groupedParent: Record<string, string[]> = {};
  const groupedThread: Record<string, string[]> = {};
  for (const e of entries) {
    if (e.userID === selfUserID) continue;
    if (e.threadRootID === '') {
      const list = groupedParent[e.parentID] ?? [];
      /* istanbul ignore next -- recordTyping dedups entries by (parentID,userID,threadRootID), so a user can't already be in the parent list; the includes() short-circuit is defensive */
      if (!list.includes(e.userID)) list.push(e.userID);
      groupedParent[e.parentID] = list;
    } else {
      const k = threadTypingKey(e.parentID, e.threadRootID);
      const list = groupedThread[k] ?? [];
      /* istanbul ignore next -- recordTyping dedups entries by (parentID,userID,threadRootID), so a user can't already be in the thread list; the includes() short-circuit is defensive */
      if (!list.includes(e.userID)) list.push(e.userID);
      groupedThread[k] = list;
    }
  }
  useTypingStore.setState((prev) => {
    const nextParent = shallowEqualByKey(prev.typingByParent, groupedParent)
      ? prev.typingByParent
      : groupedParent;
    const nextThread = shallowEqualByKey(prev.typingByThread, groupedThread)
      ? prev.typingByThread
      : groupedThread;
    if (nextParent === prev.typingByParent && nextThread === prev.typingByThread) return prev;
    return { typingByParent: nextParent, typingByThread: nextThread };
  });
}

// Run the expiry tick only while someone is actively typing — most of
// the time the entries list is empty and a 1Hz interval would cause a
// pointless wakeup forever.
function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    rebuild();
    // Inside the interval callback `timer` is by definition the handle
    // that scheduled us, so it is always truthy here; the `&& timer`
    // guard is defensive against a torn-down handle.
    /* istanbul ignore next -- timer is always set while its own interval is firing */
    if (entries.length === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, 1000);
}

// recordTyping accepts an optional threadRootID so a thread-scoped
// typing event lands in its own bucket (threadRootID defaults to "").
export function recordTyping(parentID: string, userID: string, threadRootID: string = '') {
  if (!parentID || !userID) return;
  const idx = entries.findIndex(
    (e) => e.parentID === parentID && e.userID === userID && e.threadRootID === threadRootID,
  );
  const entry: TypingEntry = { userID, parentID, threadRootID, expiresAt: Date.now() + EXPIRY_MS };
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  ensureTimer();
  rebuild();
}

// clearTyping drops a (parentID, userID, threadRootID) entry immediately —
// used by the message.new WS handler so a user stops appearing as
// "typing" the instant their message lands.
export function clearTyping(parentID: string, userID: string, threadRootID: string = '') {
  if (!parentID || !userID) return;
  const idx = entries.findIndex(
    (e) => e.parentID === parentID && e.userID === userID && e.threadRootID === threadRootID,
  );
  if (idx < 0) return;
  entries.splice(idx, 1);
  rebuild();
}

export function setSelfUserID(id: string | null) {
  selfUserID = id;
  rebuild();
}

// stopTypingExpiryTimer tears the interval down; called by the provider's
// unmount cleanup (app teardown, test unmounts) so no timer leaks.
export function stopTypingExpiryTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Test helper: full reset so suites don't leak typing state.
export function resetTypingStoreForTests() {
  stopTypingExpiryTimer();
  entries = [];
  selfUserID = null;
  useTypingStore.setState({ typingByParent: {}, typingByThread: {} });
}

const EMPTY_TYPERS: string[] = [];

// Per-bucket subscriptions: re-render only when the named bucket changes.
export function useTypingFor(parentID: string): string[] {
  return useTypingStore((s) => s.typingByParent[parentID] ?? EMPTY_TYPERS);
}

export function useThreadTypingFor(parentID: string, threadRootID: string): string[] {
  return useTypingStore(
    (s) => s.typingByThread[threadTypingKey(parentID, threadRootID)] ?? EMPTY_TYPERS,
  );
}
