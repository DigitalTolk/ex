import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { ARRIVAL_READ_WINDOW_MS, markArrivalRead, markParentRead } from './mark-read';
import { apiFetch } from '@/lib/api';
import { getAckedThrough, getReadThrough, useReadPositionStore } from '@/stores/read-position';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(() => Promise.resolve(undefined)) }));

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(undefined));
  useReadPositionStore.setState({ atBottom: {}, readThrough: {}, ackedThrough: {} });
});

interface Row { unreadCount: number; lastReadMsgID?: string }

function seeded() {
  const qc = new QueryClient();
  qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', unread: true, unreadCount: 3, unreadNotifyCount: 1, lastReadMsgID: '01A' }]);
  qc.setQueryData(['userConversations'], [{ conversationID: 'c-1', unread: true, unreadCount: 2 }]);
  return qc;
}

function readPuts(path = '/api/v1/channels/ch-1/read') {
  return vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === path);
}

describe('markParentRead', () => {
  it('reads up to a message: clears the badge, advances the cached watermark and read point, PUTs the body, acks', async () => {
    const qc = seeded();
    await markParentRead(qc, 'channel', 'ch-1', '01B');
    const row = qc.getQueryData<Row[]>(['userChannels'])![0];
    expect(row.unreadCount).toBe(0);
    expect(row.lastReadMsgID).toBe('01B');
    expect(getReadThrough('ch-1')).toBe('01B');
    expect(getAckedThrough('ch-1')).toBe('01B');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/read', {
      method: 'PUT',
      body: JSON.stringify({ upToMessageID: '01B' }),
    });
  });

  it('reads a whole conversation (no anchor): nothing to record locally', async () => {
    const qc = seeded();
    await markParentRead(qc, 'conversation', 'c-1', undefined);
    expect(qc.getQueryData<Row[]>(['userConversations'])![0].unreadCount).toBe(0);
    expect(getReadThrough('c-1')).toBeUndefined();
    expect(getAckedThrough('c-1')).toBeUndefined();
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/c-1/read', { method: 'PUT' });
  });

  it('a failed PUT is swallowed and NOT acked, so the next trigger retries it', async () => {
    vi.mocked(apiFetch).mockImplementation(() => Promise.reject(new Error('down')));
    const qc = seeded();
    await expect(markParentRead(qc, 'channel', 'ch-1', '01B')).resolves.toBeUndefined();
    expect(getReadThrough('ch-1')).toBe('01B');
    expect(getAckedThrough('ch-1')).toBeUndefined();
  });

  it('never moves the cached watermark backwards', async () => {
    const qc = seeded();
    await markParentRead(qc, 'channel', 'ch-1', '00Z');
    expect(qc.getQueryData<Row[]>(['userChannels'])![0].lastReadMsgID).toBe('01A');
  });
});

describe('markArrivalRead', () => {
  it('PUTs the first arrival at once and coalesces the rest of the window into one trailing PUT', async () => {
    vi.useFakeTimers();
    const qc = seeded();
    markArrivalRead(qc, 'channel', 'ch-1', '01B');
    markArrivalRead(qc, 'channel', 'ch-1', '01D');
    markArrivalRead(qc, 'channel', 'ch-1', '01C');
    expect(readPuts()).toHaveLength(1);
    // The local half applies to every arrival immediately.
    expect(getReadThrough('ch-1')).toBe('01D');
    await vi.advanceTimersByTimeAsync(ARRIVAL_READ_WINDOW_MS);
    expect(readPuts()).toHaveLength(2);
    expect(readPuts()[1][1]).toEqual({ method: 'PUT', body: JSON.stringify({ upToMessageID: '01D' }) });
    // The window closed: the next arrival leads a new one.
    markArrivalRead(qc, 'channel', 'ch-1', '01E');
    expect(readPuts()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(ARRIVAL_READ_WINDOW_MS);
    expect(readPuts()).toHaveLength(3);
  });

  it('keeps windows per parent and per client', () => {
    vi.useFakeTimers();
    const qc = seeded();
    const other = seeded();
    markArrivalRead(qc, 'channel', 'ch-1', '01B');
    markArrivalRead(other, 'channel', 'ch-1', '01B');
    markArrivalRead(qc, 'conversation', 'c-1', '01B');
    expect(readPuts()).toHaveLength(2);
    expect(readPuts('/api/v1/conversations/c-1/read')).toHaveLength(1);
  });
});
