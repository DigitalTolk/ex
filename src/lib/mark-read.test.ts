import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { markParentRead } from './mark-read';
import { queryKeys } from './query-keys';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch }));

function client() {
  const qc = new QueryClient();
  qc.setQueryData(queryKeys.userChannels(), [{ channelID: 'ch 1', unreadCount: 3, unreadNotifyCount: 1 }]);
  qc.setQueryData(queryKeys.userConversations(), [{ conversationID: 'dm-1', unreadCount: 2, unreadNotifyCount: 2 }]);
  return qc;
}

describe('markParentRead', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(undefined);
  });

  it('clears a channel badge at once and persists the read', async () => {
    const qc = client();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const done = markParentRead(qc, { kind: 'channel', id: 'ch 1' });
    expect(qc.getQueryData<{ unreadCount: number }[]>(queryKeys.userChannels())?.[0].unreadCount).toBe(0);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch%201/read', { method: 'PUT' });
    await done;
    // Read as it arrives: no list refetch per message.
    expect(invalidate).not.toHaveBeenCalled();
  });

  // Opening a chat costs one write: the row's count is the server's zero
  // already, so neither list is fetched again.
  it('reads a conversation without refetching its list', async () => {
    const qc = client();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await markParentRead(qc, { kind: 'conversation', id: 'dm-1' });
    expect(qc.getQueryData<{ unreadCount: number }[]>(queryKeys.userConversations())?.[0].unreadCount).toBe(0);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/dm-1/read', { method: 'PUT' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('swallows a failed PUT and keeps the badge cleared', async () => {
    apiFetch.mockRejectedValue(new Error('offline'));
    const qc = client();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await expect(markParentRead(qc, { kind: 'channel', id: 'ch 1' })).resolves.toBeUndefined();
    expect(qc.getQueryData<{ unreadCount: number }[]>(queryKeys.userChannels())?.[0].unreadCount).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
