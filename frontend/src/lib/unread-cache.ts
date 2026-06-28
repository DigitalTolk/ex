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
  patchChannel(qc, channelID, (c) => ({ ...c, unread: false, unreadCount: 0 }));
}

/** A new top-level message bumped this conversation's unread count by one. */
export function bumpConversationUnread(qc: QueryClient, conversationID: string) {
  patchConversation(qc, conversationID, (c) => ({ ...c, unread: true, unreadCount: (c.unreadCount ?? 0) + 1 }));
}

/** The user opened/read this conversation — reset the badge immediately. */
export function clearConversationUnreadInCache(qc: QueryClient, conversationID: string) {
  patchConversation(qc, conversationID, (c) => ({ ...c, unread: false, unreadCount: 0 }));
}
