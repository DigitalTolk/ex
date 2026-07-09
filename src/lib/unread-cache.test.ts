import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { UserChannel, UserConversation } from '@/types';
import {
  bumpChannelUnread,
  clearChannelUnreadInCache,
  bumpConversationUnread,
  clearConversationUnreadInCache,
  touchConversationActivityInCache,
} from './unread-cache';

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('unread-cache', () => {
  it('bumpChannelUnread increments the count and sets unread on the matching row only', () => {
    const qc = makeQC();
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
      { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1, unreadCount: 2 },
      { channelID: 'ch-2', channelName: 'other', channelType: 'public', role: 1 },
    ]);

    bumpChannelUnread(qc, 'ch-1');
    const data = qc.getQueryData<UserChannel[]>(queryKeys.userChannels())!;
    expect(data.find((c) => c.channelID === 'ch-1')).toMatchObject({ unread: true, unreadCount: 3 });
    // Untouched row unchanged.
    expect(data.find((c) => c.channelID === 'ch-2')).toMatchObject({ channelID: 'ch-2' });
    expect(data.find((c) => c.channelID === 'ch-2')?.unreadCount).toBeUndefined();
  });

  it('bumpChannelUnread treats a missing count as 0', () => {
    const qc = makeQC();
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
      { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
    ]);
    bumpChannelUnread(qc, 'ch-1');
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0]).toMatchObject({ unread: true, unreadCount: 1 });
  });

  it('clearChannelUnreadInCache resets the row to read', () => {
    const qc = makeQC();
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
      { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1, unread: true, unreadCount: 5 },
    ]);
    clearChannelUnreadInCache(qc, 'ch-1');
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0]).toMatchObject({ unread: false, unreadCount: 0 });
  });

  it('bump/clear conversation patch only the matching row; a missing count counts as 0', () => {
    const qc = makeQC();
    qc.setQueryData<UserConversation[]>(queryKeys.userConversations(), [
      { conversationID: 'conv-1', type: 'dm', participantIDs: ['a', 'b'] }, // no unreadCount → treated as 0
      { conversationID: 'conv-2', type: 'dm', participantIDs: ['a', 'c'], unreadCount: 5 },
    ]);
    bumpConversationUnread(qc, 'conv-1');
    const data = qc.getQueryData<UserConversation[]>(queryKeys.userConversations())!;
    expect(data.find((c) => c.conversationID === 'conv-1')).toMatchObject({ unread: true, unreadCount: 1 });
    // The other row is untouched (non-matching branch).
    expect(data.find((c) => c.conversationID === 'conv-2')?.unreadCount).toBe(5);

    clearConversationUnreadInCache(qc, 'conv-1');
    expect(qc.getQueryData<UserConversation[]>(queryKeys.userConversations())!.find((c) => c.conversationID === 'conv-1'))
      .toMatchObject({ unread: false, unreadCount: 0 });
  });

  it('is a no-op when the list cache is empty (row not yet loaded)', () => {
    const qc = makeQC();
    // No query data set at all.
    bumpChannelUnread(qc, 'ch-x');
    bumpConversationUnread(qc, 'conv-x');
    clearChannelUnreadInCache(qc, 'ch-x');
    clearConversationUnreadInCache(qc, 'conv-x');
    expect(qc.getQueryData(queryKeys.userChannels())).toBeUndefined();
    expect(qc.getQueryData(queryKeys.userConversations())).toBeUndefined();
  });
});

describe('touchConversationActivityInCache', () => {
  it('patches the matching row updatedAt in place and reports found', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.userConversations(), [
      { conversationID: 'c-1', type: 'dm', displayName: 'A', updatedAt: '2026-01-01T00:00:00Z' },
      { conversationID: 'c-2', type: 'dm', displayName: 'B', updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    const found = touchConversationActivityInCache(qc, 'c-1', '2026-07-02T10:00:00Z');
    expect(found).toBe(true);
    const rows = qc.getQueryData(queryKeys.userConversations()) as Array<{ conversationID: string; updatedAt?: string }>;
    expect(rows.find((r) => r.conversationID === 'c-1')?.updatedAt).toBe('2026-07-02T10:00:00Z');
    expect(rows.find((r) => r.conversationID === 'c-2')?.updatedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('reports not-found for an unlisted conversation (caller falls back to a refetch)', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.userConversations(), [
      { conversationID: 'c-1', type: 'dm', displayName: 'A' },
    ]);
    expect(touchConversationActivityInCache(qc, 'c-ghost', '2026-07-02T10:00:00Z')).toBe(false);
  });

  it('reports not-found when the list was never fetched', () => {
    const qc = new QueryClient();
    expect(touchConversationActivityInCache(qc, 'c-1', '2026-07-02T10:00:00Z')).toBe(false);
  });
});
