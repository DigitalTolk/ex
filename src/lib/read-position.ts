import { create } from 'zustand';

// Per-view-session read position for an open chat or thread: where the
// "New messages" line sits, whether the user is parked at the live tail, and
// whether they marked something unread (which must not be auto-read again
// until they leave). One zustand store, so the views, the message list and
// ChatPage's WS switchboard share one answer without prop-drilling; a session
// ends when the view closes (endReadSession).
//
// Keys are the channel / conversation id, or `thread:<rootID>` for threads.

// Where the first unread message is:
//   message — known exactly (marked unread, or arrived while you weren't
//             following along)
//   count   — the last N counted messages (the server's unread count when
//             the chat was opened); the list resolves it to a message
//   after   — threads: the first reply newer than this ISO time
export type UnreadAnchor =
  | { kind: 'message'; messageID: string }
  | { kind: 'count'; count: number }
  | { kind: 'after'; at: string };

type Keyed<T> = Readonly<Record<string, T>>;

interface ReadPositionState {
  anchors: Keyed<UnreadAnchor>;
  // Lines the user has seen (they faded out): the row keeps its place so the
  // messages don't shift, but it is invisible and the banner/pill retire.
  seen: Keyed<true>;
  holds: Keyed<true>;
  notAtBottom: Keyed<true>;
  notAtLiveTail: Keyed<true>;
  missed: Keyed<number>;
  // Session ends deferred by scheduleEndReadSession, by key.
  pendingEnds: Keyed<ReturnType<typeof setTimeout>>;
}

const useReadPositionStore = create<ReadPositionState>(() => ({
  anchors: {},
  seen: {},
  holds: {},
  notAtBottom: {},
  notAtLiveTail: {},
  missed: {},
  pendingEnds: {},
}));

const state = () => useReadPositionStore.getState();
const has = (record: Keyed<unknown>, key: string) => Object.hasOwn(record, key);

function without<T>(record: Keyed<T>, key: string): Keyed<T> {
  if (!has(record, key)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function withFlag(record: Keyed<true>, key: string, on: boolean): Keyed<true> {
  if (!on) return without(record, key);
  return has(record, key) ? record : { ...record, [key]: true };
}

export function threadReadKey(threadRootID: string): string {
  return `thread:${threadRootID}`;
}

// setUnreadAnchor records where the line goes. By default the first anchor of
// a session wins — the line marks the FIRST unread message — and later calls
// are ignored; `replace` overrides (mark-unread moves the line to the message).
export function setUnreadAnchor(key: string, anchor: UnreadAnchor, opts: { replace?: boolean } = {}): void {
  const { anchors, seen } = state();
  if (has(anchors, key) && !opts.replace) return;
  useReadPositionStore.setState({ anchors: { ...anchors, [key]: anchor }, seen: without(seen, key) });
}

export function markUnreadSeen(key: string): void {
  useReadPositionStore.setState({ seen: withFlag(state().seen, key, true) });
}

export function isUnreadSeen(key: string): boolean {
  return has(state().seen, key);
}

export function getUnreadAnchor(key: string): UnreadAnchor | undefined {
  const { anchors } = state();
  return has(anchors, key) ? anchors[key] : undefined;
}

export function clearUnreadAnchor(key: string): void {
  const { anchors, seen } = state();
  useReadPositionStore.setState({ anchors: without(anchors, key), seen: without(seen, key) });
}

// holdRead pins the chat unread after "Mark as unread": nothing auto-reads it
// (arrivals, refocus, reaching the bottom) until the session ends or the user
// explicitly marks it read.
export function holdRead(key: string): void {
  useReadPositionStore.setState({ holds: withFlag(state().holds, key, true) });
}

export function releaseRead(key: string): void {
  useReadPositionStore.setState({ holds: without(state().holds, key) });
}

export function isReadHeld(key: string): boolean {
  return has(state().holds, key);
}

// The message list reports whether the user is at the live tail; an arrival
// only counts as read when they are (no list mounted reads as "at bottom").
export function setAtBottom(key: string, atBottom: boolean): void {
  useReadPositionStore.setState({ notAtBottom: withFlag(state().notAtBottom, key, !atBottom) });
}

export function isAtBottom(key: string): boolean {
  return !has(state().notAtBottom, key);
}

// A list opened from a link (search, "jump to message", a thread alert) shows
// a window of history that may not reach the newest messages. Arrivals can't
// be shown in it, so they're counted as missed for the list's "new messages"
// pill instead of being read.
export function setAtLiveTail(key: string, atTail: boolean): void {
  useReadPositionStore.setState({ notAtLiveTail: withFlag(state().notAtLiveTail, key, !atTail) });
}

export function isAtLiveTail(key: string): boolean {
  return !has(state().notAtLiveTail, key);
}

export function noteMissedArrival(key: string): void {
  const { missed } = state();
  useReadPositionStore.setState({ missed: { ...missed, [key]: (has(missed, key) ? missed[key] : 0) + 1 } });
}

export function clearMissedArrivals(key: string): void {
  useReadPositionStore.setState({ missed: without(state().missed, key) });
}

export function endReadSession(key: string): void {
  const s = state();
  useReadPositionStore.setState({
    holds: without(s.holds, key),
    notAtBottom: without(s.notAtBottom, key),
    notAtLiveTail: without(s.notAtLiveTail, key),
    missed: without(s.missed, key),
    anchors: without(s.anchors, key),
    seen: without(s.seen, key),
  });
}

// Leaving is deferred a tick and cancelled if the same chat mounts again at
// once: React StrictMode (dev) unmounts + remounts every effect, which would
// otherwise wipe the line the moment it was recorded.
export function scheduleEndReadSession(key: string): void {
  keepReadSession(key);
  const pending = setTimeout(() => {
    // Only the end this store still has pending: a reset of the store (a new
    // test) drops it, and the session started after that must not end.
    if (state().pendingEnds[key] !== pending) return;
    useReadPositionStore.setState({ pendingEnds: without(state().pendingEnds, key) });
    endReadSession(key);
  }, 0);
  useReadPositionStore.setState({ pendingEnds: { ...state().pendingEnds, [key]: pending } });
}

export function keepReadSession(key: string): void {
  const { pendingEnds } = state();
  if (!has(pendingEnds, key)) return;
  clearTimeout(pendingEnds[key]);
  useReadPositionStore.setState({ pendingEnds: without(pendingEnds, key) });
}

export function useUnreadAnchor(key: string | undefined): UnreadAnchor | undefined {
  return useReadPositionStore((s) => (key && has(s.anchors, key) ? s.anchors[key] : undefined));
}

export function useUnreadSeen(key: string | undefined): boolean {
  return useReadPositionStore((s) => (key ? has(s.seen, key) : false));
}

export function useMissedArrivals(key: string | undefined): number {
  return useReadPositionStore((s) => (key && has(s.missed, key) ? s.missed[key] : 0));
}
