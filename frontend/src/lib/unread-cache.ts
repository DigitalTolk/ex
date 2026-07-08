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

/** A new top-level message bumped this channel's unread count by one. */
export function bumpChannelUnread(qc: QueryClient, channelID: string) {
  patchChannel(qc, channelID, (c) => ({ ...c, unread: true, unreadCount: (c.unreadCount ?? 0) + 1 }));
}

/** The user opened/read this channel — reset the badge immediately (the PUT /read refetch confirms). */
export function clearChannelUnreadInCache(qc: QueryClient, channelID: string) {
  patchChannel(qc, channelID, (c) => ({ ...c, unread: false, unreadCount: 0, unreadNotifyCount: 0 }));
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
export function bumpConversationUnread(qc: QueryClient, conversationID: string) {
  patchConversation(qc, conversationID, (c) => ({ ...c, unread: true, unreadCount: (c.unreadCount ?? 0) + 1 }));
}

/** The user opened/read this conversation — reset the badge immediately. */
export function clearConversationUnreadInCache(qc: QueryClient, conversationID: string) {
  patchConversation(qc, conversationID, (c) => ({ ...c, unread: false, unreadCount: 0, unreadNotifyCount: 0 }));
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
