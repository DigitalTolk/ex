import { useSyncExternalStore } from 'react';

// Per-view-session read position for an open chat or thread: where the
// "New messages" line sits, whether the user is parked at the live tail, and
// whether they marked something unread (which must not be auto-read again
// until they leave). Module-level so the views, the message list and
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

const anchors = new Map<string, UnreadAnchor>();
const holds = new Set<string>();
const notAtBottom = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function threadReadKey(threadRootID: string): string {
  return `thread:${threadRootID}`;
}

// setUnreadAnchor records where the line goes. By default the first anchor of
// a session wins — the line marks the FIRST unread message — and later calls
// are ignored; `replace` overrides (mark-unread moves the line to the message).
export function setUnreadAnchor(key: string, anchor: UnreadAnchor, opts: { replace?: boolean } = {}): void {
  if (anchors.has(key) && !opts.replace) return;
  anchors.set(key, anchor);
  emit();
}

export function getUnreadAnchor(key: string): UnreadAnchor | undefined {
  return anchors.get(key);
}

export function clearUnreadAnchor(key: string): void {
  if (anchors.delete(key)) emit();
}

// holdRead pins the chat unread after "Mark as unread": nothing auto-reads it
// (arrivals, refocus, reaching the bottom) until the session ends or the user
// explicitly marks it read.
export function holdRead(key: string): void {
  holds.add(key);
}

export function releaseRead(key: string): void {
  holds.delete(key);
}

export function isReadHeld(key: string): boolean {
  return holds.has(key);
}

// The message list reports whether the user is at the live tail; an arrival
// only counts as read when they are (no list mounted reads as "at bottom").
export function setAtBottom(key: string, atBottom: boolean): void {
  if (atBottom) notAtBottom.delete(key);
  else notAtBottom.add(key);
}

export function isAtBottom(key: string): boolean {
  return !notAtBottom.has(key);
}

export function endReadSession(key: string): void {
  holds.delete(key);
  notAtBottom.delete(key);
  clearUnreadAnchor(key);
}

// Leaving is deferred a tick and cancelled if the same chat mounts again at
// once: React StrictMode (dev) unmounts + remounts every effect, which would
// otherwise wipe the line the moment it was recorded.
const pendingEnds = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleEndReadSession(key: string): void {
  keepReadSession(key);
  pendingEnds.set(
    key,
    setTimeout(() => {
      pendingEnds.delete(key);
      endReadSession(key);
    }, 0),
  );
}

export function keepReadSession(key: string): void {
  const pending = pendingEnds.get(key);
  if (pending === undefined) return;
  clearTimeout(pending);
  pendingEnds.delete(key);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUnreadAnchor(key: string | undefined): UnreadAnchor | undefined {
  return useSyncExternalStore(subscribe, () => (key ? anchors.get(key) : undefined));
}
