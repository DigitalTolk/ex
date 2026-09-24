import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { UserChannel, UserConversation } from '@/types';
import {
  applyChannelReadInCache,
  applyConversationReadInCache,
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

describe('unread-cache read watermark', () => {
  it('clear* advances lastReadMsgID forward-only and keeps it without an ID', () => {
    const qc = makeQC();
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
      { channelID: 'ch-1', channelName: 'g', channelType: 'public', role: 1, lastReadMsgID: '01B', unreadCount: 2 },
    ]);
    qc.setQueryData<UserConversation[]>(queryKeys.userConversations(), [
      { conversationID: 'c-1', type: 'dm', displayName: 'x' },
    ]);
    clearChannelUnreadInCache(qc, 'ch-1', '01A');
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0].lastReadMsgID).toBe('01B');
    clearChannelUnreadInCache(qc, 'ch-1', '01C');
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0].lastReadMsgID).toBe('01C');
    clearChannelUnreadInCache(qc, 'ch-1');
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0].lastReadMsgID).toBe('01C');
    clearConversationUnreadInCache(qc, 'c-1', '01A');
    expect(qc.getQueryData<UserConversation[]>(queryKeys.userConversations())![0].lastReadMsgID).toBe('01A');
  });

  it('apply*ReadInCache sets the server count and watermark in place', () => {
    const qc = makeQC();
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
      { channelID: 'ch-1', channelName: 'g', channelType: 'public', role: 1, unreadCount: 5, unreadNotifyCount: 2 },
    ]);
    qc.setQueryData<UserConversation[]>(queryKeys.userConversations(), [
      { conversationID: 'c-1', type: 'dm', displayName: 'x', unreadCount: 1, lastReadMsgID: '01Z' },
    ]);
    applyChannelReadInCache(qc, 'ch-1', { unreadCount: 2, lastReadMsgID: '01B' });
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0]).toMatchObject({
      unread: true, unreadCount: 2, unreadNotifyCount: 0, lastReadMsgID: '01B',
    });
    applyConversationReadInCache(qc, 'c-1', { unreadCount: 0, lastReadMsgID: '01A' });
    expect(qc.getQueryData<UserConversation[]>(queryKeys.userConversations())![0]).toMatchObject({
      unread: false, unreadCount: 0, lastReadMsgID: '01Z',
    });
  });

  // Echoes arrive on another topic than message.new — late or out of order.
  it('drops an echo for a read point behind the cached one', () => {
    const qc = makeQC();
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
      { channelID: 'ch-1', channelName: 'g', channelType: 'public', role: 1, unreadCount: 0, lastReadSeq: 5 },
    ]);
    applyChannelReadInCache(qc, 'ch-1', { unreadCount: 1, lastReadSeq: 4, messageSeq: 5 });
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0]).toMatchObject({ unreadCount: 0, lastReadSeq: 5 });
  });

  it('keeps the unread of a message seen arriving after the echo was computed', () => {
    const qc = makeQC();
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
      { channelID: 'ch-1', channelName: 'g', channelType: 'public', role: 1, unreadCount: 0, lastReadSeq: 4 },
    ]);
    qc.setQueryData<UserConversation[]>(queryKeys.userConversations(), [
      { conversationID: 'c-1', type: 'dm', displayName: 'x' },
    ]);
    // M6 (seq 6) lands and bumps before the echo of a read at seq 5.
    bumpChannelUnread(qc, 'ch-1', 6);
    bumpChannelUnread(qc, 'ch-1');
    applyChannelReadInCache(qc, 'ch-1', { unreadCount: 0, lastReadSeq: 5, messageSeq: 5 });
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0]).toMatchObject({
      unread: true, unreadCount: 1, lastReadSeq: 5, seenSeq: 6,
    });
    bumpConversationUnread(qc, 'c-1', 3);
    bumpConversationUnread(qc, 'c-1');
    applyConversationReadInCache(qc, 'c-1', { unreadCount: 0, lastReadSeq: 3, messageSeq: 3 });
    expect(qc.getQueryData<UserConversation[]>(queryKeys.userConversations())![0]).toMatchObject({
      unread: false, unreadCount: 0, lastReadSeq: 3, seenSeq: 3,
    });
  });
});
