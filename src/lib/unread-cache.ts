import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { UserChannel, UserConversation } from '@/types';

// Single source of truth for sidebar/title unread is the userChannels /
// userConversations React-Query list cache (server seq-derived unread/unreadCount).
// Live WS events patch that cache in place — the same WS-driven-cache pattern the
// message list uses — so there's no separate session-delta to reconcile (which was
// the old double-count bug). A reconnect refetch reconciles to server truth.

function patchChannel(qc: QueryClient, id: string, fn: (c: UserChannel) => UserChannel) {
  const prev = qc.getQueryData<UserChannel[]>(queryKeys.userChannels());
  if (!prev) return; // row not loaded yet — badge appears on the next list refetch
  qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), prev.map((c) => (c.channelID === id ? fn(c) : c)));
}

function patchConversation(qc: QueryClient, id: string, fn: (c: UserConversation) => UserConversation) {
  const prev = qc.getQueryData<UserConversation[]>(queryKeys.userConversations());
  if (!prev) return;
  qc.setQueryData<UserConversation[]>(queryKeys.userConversations(), prev.map((c) => (c.conversationID === id ? fn(c) : c)));
}

/**
 * A new top-level message bumped this channel's unread count by one. Its seq
 * (when the payload carries one) is remembered so a read echo computed before
 * it landed can't erase it (applyChannelReadInCache).
 */
export function bumpChannelUnread(qc: QueryClient, channelID: string, seq?: number) {
  patchChannel(qc, channelID, (c) => ({
    ...c,
    unread: true,
    unreadCount: (c.unreadCount ?? 0) + 1,
    seenSeq: seq !== undefined ? Math.max(c.seenSeq ?? 0, seq) : c.seenSeq,
  }));
}

// laterId: the later of two optional message IDs (ULIDs sort in send order),
// so a cached read-point watermark only ever moves forward.
function laterId(prev: string | undefined, next: string | undefined): string | undefined {
  if (!next) return prev;
  return !prev || next > prev ? next : prev;
}

/**
 * The user opened/read this channel — reset the badge immediately. With
 * lastReadMsgID (the read point just persisted) the cached watermark moves
 * forward too, so the next open doesn't put a "New" divider above messages
 * that were read live.
 */
export function clearChannelUnreadInCache(qc: QueryClient, channelID: string, lastReadMsgID?: string) {
  patchChannel(qc, channelID, (c) => ({
    ...c,
    unread: false,
    unreadCount: 0,
    unreadNotifyCount: 0,
    lastReadMsgID: laterId(c.lastReadMsgID, lastReadMsgID),
  }));
}

/** The server's mark-read echo (userchannel.updated). */
export interface ReadEcho {
  unreadCount: number;
  lastReadMsgID?: string;
  lastReadSeq?: number;
  messageSeq?: number;
}

// applyReadEcho folds a read echo into a list row. Echoes travel on a
// different topic than message.new, so they can arrive late or out of order:
//  - an echo for a read point BEHIND the cached one is dropped (a newer read
//    already applied — setting its count would resurrect read messages);
//  - the count is never less than the messages this tab has SEEN arrive past
//    the echo's read point (a message that landed after the server computed
//    the count keeps its unread).
function applyReadEcho<R extends { unreadCount?: number; unread?: boolean; unreadNotifyCount?: number; lastReadMsgID?: string; lastReadSeq?: number; seenSeq?: number }>(
  c: R,
  e: ReadEcho,
): R {
  if (e.lastReadSeq !== undefined && c.lastReadSeq !== undefined && e.lastReadSeq < c.lastReadSeq) return c;
  let count = e.unreadCount;
  if (e.lastReadSeq !== undefined) {
    const known = Math.max(e.messageSeq ?? 0, c.seenSeq ?? 0);
    count = Math.max(count, known - e.lastReadSeq);
  }
  return {
    ...c,
    unread: count > 0,
    unreadCount: count,
    unreadNotifyCount: 0,
    lastReadSeq: e.lastReadSeq ?? c.lastReadSeq,
    lastReadMsgID: laterId(c.lastReadMsgID, e.lastReadMsgID),
  };
}

/**
 * A read landed (this tab or another — the server's userchannel.updated echo):
 * set the remaining count and advance the watermark in place, no list
 * refetch. A read-up-to-message can leave messages unread, so the count is
 * SET (see applyReadEcho for the ordering rules), not cleared.
 */
export function applyChannelReadInCache(qc: QueryClient, channelID: string, echo: ReadEcho) {
  patchChannel(qc, channelID, (c) => applyReadEcho(c, echo));
}

/**
 * A notification.new for a top-level message carried the recipient's
 * authoritative alerted-unread badge — SET it (never increment locally; the
 * server counted once, at the moment the alert decision fired). The alert
 * implies an unread message, so the availability indicator lights up too,
 * independent of message.new ordering.
 */
export function setChannelNotifyCountInCache(qc: QueryClient, channelID: string, count: number) {
  patchChannel(qc, channelID, (c) => ({
    ...c,
    unread: true,
    unreadCount: Math.max(c.unreadCount ?? 0, 1),
    unreadNotifyCount: count,
  }));
}

/** A new top-level message bumped this conversation's unread count by one. */
export function bumpConversationUnread(qc: QueryClient, conversationID: string, seq?: number) {
  patchConversation(qc, conversationID, (c) => ({
    ...c,
    unread: true,
    unreadCount: (c.unreadCount ?? 0) + 1,
    seenSeq: seq !== undefined ? Math.max(c.seenSeq ?? 0, seq) : c.seenSeq,
  }));
}

/** The user opened/read this conversation — reset the badge immediately. */
export function clearConversationUnreadInCache(qc: QueryClient, conversationID: string, lastReadMsgID?: string) {
  patchConversation(qc, conversationID, (c) => ({
    ...c,
    unread: false,
    unreadCount: 0,
    unreadNotifyCount: 0,
    lastReadMsgID: laterId(c.lastReadMsgID, lastReadMsgID),
  }));
}

/** Conversation twin of applyChannelReadInCache. */
export function applyConversationReadInCache(qc: QueryClient, conversationID: string, echo: ReadEcho) {
  patchConversation(qc, conversationID, (c) => applyReadEcho(c, echo));
}

/** Conversation twin of setChannelNotifyCountInCache. */
export function setConversationNotifyCountInCache(qc: QueryClient, conversationID: string, count: number) {
  patchConversation(qc, conversationID, (c) => ({
    ...c,
    unread: true,
    unreadCount: Math.max(c.unreadCount ?? 0, 1),
    unreadNotifyCount: count,
  }));
}

/**
 * A new top-level message re-ordered this conversation: patch the row's
 * updatedAt in place (the sidebar sorts on it) instead of refetching the
 * whole list — a send used to trigger a four-query refetch burst via a
 * blanket-invalidating userchannel.updated handler. Returns false when the
 * row isn't cached (e.g. a just-activated conversation) so the caller can
 * fall back to a refetch.
 */
export function touchConversationActivityInCache(
  qc: QueryClient,
  conversationID: string,
  updatedAt: string,
): boolean {
  const prev = qc.getQueryData<UserConversation[]>(queryKeys.userConversations());
  if (!prev) return false;
  let found = false;
  const next = prev.map((c) => {
    if (c.conversationID !== conversationID) return c;
    found = true;
    return { ...c, updatedAt };
  });
  if (found) qc.setQueryData<UserConversation[]>(queryKeys.userConversations(), next);
  return found;
}
