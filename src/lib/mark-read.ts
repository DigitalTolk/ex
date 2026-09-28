import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { clearChannelUnreadInCache, clearConversationUnreadInCache } from '@/lib/unread-cache';
import { setAckedThrough, setReadThrough } from '@/stores/read-position';

export type ReadParentKind = 'channel' | 'conversation';

// applyLocalRead is the instant, client-side half of a read: drop the sidebar
// badge, advance the cached server watermark, and advance the local read point
// (stores/read-position) so the open list treats the message as seen.
function applyLocalRead(qc: QueryClient, kind: ReadParentKind, parentID: string, upToMessageID: string | undefined) {
  if (kind === 'channel') clearChannelUnreadInCache(qc, parentID, upToMessageID);
  else clearConversationUnreadInCache(qc, parentID, upToMessageID);
  if (upToMessageID) setReadThrough(parentID, upToMessageID);
}

// markParentRead is the one way the client persists a read: the local half
// above, then the PUT. With upToMessageID the server reads up to and
// including that message only — anything newer stays unread; without it
// (nothing anchorable loaded) the server catches the user up entirely.
//
// The server's userchannel.updated echo carries the remaining count + the
// watermark and patches every tab's list in place (ChatPage), so there is no
// list refetch here. The acked read point advances only once the PUT
// succeeds, so a failed PUT is retried by the next read trigger instead of
// being deduped away.
export function markParentRead(
  qc: QueryClient,
  kind: ReadParentKind,
  parentID: string,
  upToMessageID: string | undefined,
): Promise<void> {
  applyLocalRead(qc, kind, parentID, upToMessageID);
  const path = `/api/v1/${kind === 'channel' ? 'channels' : 'conversations'}/${encodeURIComponent(parentID)}/read`;
  const init: RequestInit = upToMessageID
    ? { method: 'PUT', body: JSON.stringify({ upToMessageID }) }
    : { method: 'PUT' };
  return apiFetch<void>(path, init).then(
    () => {
      if (upToMessageID) setAckedThrough(parentID, upToMessageID);
    },
    () => undefined,
  );
}

// Arrival reads (a message landing while the user watches the tail) are
// coalesced per parent: the first one PUTs immediately, any others within the
// window collapse into ONE trailing PUT for the newest. A busy channel costs
// at most ~one read write per second per watching member instead of one per
// message. The local half still applies to every arrival at once.
export const ARRIVAL_READ_WINDOW_MS = 1000;

interface ArrivalWindow {
  pending?: string;
}
// Keyed by QueryClient so independent clients (tests, multiple roots) never
// share windows.
const arrivalWindows = new WeakMap<QueryClient, Map<string, ArrivalWindow>>();

export function markArrivalRead(qc: QueryClient, kind: ReadParentKind, parentID: string, messageID: string): void {
  let windows = arrivalWindows.get(qc);
  if (!windows) {
    windows = new Map();
    arrivalWindows.set(qc, windows);
  }
  const open = windows.get(parentID);
  if (open) {
    applyLocalRead(qc, kind, parentID, messageID);
    if (!open.pending || messageID > open.pending) open.pending = messageID;
    return;
  }
  const win: ArrivalWindow = {};
  windows.set(parentID, win);
  void markParentRead(qc, kind, parentID, messageID);
  setTimeout(() => {
    windows.delete(parentID);
    if (win.pending) void markParentRead(qc, kind, parentID, win.pending);
  }, ARRIVAL_READ_WINDOW_MS);
}
