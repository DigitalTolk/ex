import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  scheduledFor,
  useComposerSchedule,
  useDeleteScheduledMessage,
  useScheduleMessage,
  useScheduledMessages,
  useSendScheduledNow,
  useUpdateScheduledMessage,
} from './useScheduledMessages';
import { queryKeys } from '@/lib/query-keys';
import type { MessageDraft, ScheduledMessage } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast: toast }));

const sm = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: 's-1',
  userID: 'u-1',
  parentID: 'ch-1',
  parentType: 'channel',
  body: 'hi',
  sendAt: '2099-01-01T09:00:00Z',
  state: 'pending',
  createdAt: '',
  updatedAt: '',
  ...over,
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const where = { path: '' };
  function Where() {
    const loc = useLocation();
    where.path = loc.pathname + loc.search;
    return null;
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        {children}
        <Where />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, wrapper, where };
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  toast.mockReset();
});

describe('useScheduledMessages', () => {
  it('lists them, and treats anything but a list as empty', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([sm()]);
    const a = setup();
    const { result } = renderHook(() => useScheduledMessages(), { wrapper: a.wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    vi.mocked(apiFetch).mockResolvedValueOnce(undefined);
    const b = setup();
    const r2 = renderHook(() => useScheduledMessages(), { wrapper: b.wrapper });
    await waitFor(() => expect(r2.result.current.data).toEqual([]));
  });

  it('narrows to a composer: the chat itself, or one thread', () => {
    const list = [sm({ id: 'a' }), sm({ id: 'b', parentMessageID: 'root' }), sm({ id: 'c', parentID: 'ch-2' })];
    expect(scheduledFor(list, 'ch-1').map((m) => m.id)).toEqual(['a']);
    expect(scheduledFor(list, 'ch-1', 'root').map((m) => m.id)).toEqual(['b']);
    expect(scheduledFor(undefined, 'ch-1')).toEqual([]);
  });
});

describe('scheduled message mutations', () => {
  it('scheduling posts it and empties that composer\'s draft, like a send', async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData<MessageDraft[]>(queryKeys.drafts(), [
      { id: 'd-1', userID: 'u-1', parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root', body: 'x', attachmentIDs: [], updatedAt: '', createdAt: '' } as MessageDraft,
    ]);
    vi.mocked(apiFetch).mockResolvedValue(sm());
    const { result } = renderHook(() => useScheduleMessage(), { wrapper });
    const sendAt = new Date('2099-01-01T09:00:00Z');
    await act(() =>
      result.current.mutateAsync({ parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root', body: 'hi', attachmentIDs: ['a'], sendAt }),
    );
    const [path, init] = vi.mocked(apiFetch).mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/api/v1/scheduled-messages');
    expect(JSON.parse(init.body)).toEqual({ parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root', body: 'hi', attachmentIDs: ['a'], sendAt: sendAt.toISOString() });
    expect(qc.getQueryData(queryKeys.drafts())).toEqual([]);
  });

  it('a failed schedule leaves the draft alone', async () => {
    const { wrapper } = setup();
    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useScheduleMessage(), { wrapper });
    await act(async () => {
      await result.current
        .mutateAsync({ parentID: 'ch-1', parentType: 'conversation', body: 'hi', attachmentIDs: [], sendAt: new Date() })
        .catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const [, init] = vi.mocked(apiFetch).mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).parentMessageID).toBe('');
  });

  it('edit, delete and send now hit their endpoints', async () => {
    const { wrapper } = setup();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const update = renderHook(() => useUpdateScheduledMessage(), { wrapper }).result;
    const del = renderHook(() => useDeleteScheduledMessage(), { wrapper }).result;
    const send = renderHook(() => useSendScheduledNow(), { wrapper }).result;
    const sendAt = new Date('2099-02-01T09:00:00Z');
    await act(() => update.current.mutateAsync({ id: 's/1', body: 'edited', sendAt }));
    await act(() => update.current.mutateAsync({ id: 's-2', body: 'text only' }));
    await act(() => del.current.mutateAsync('s-3'));
    await act(() => send.current.mutateAsync('s-4'));
    const calls = vi.mocked(apiFetch).mock.calls as [string, { method: string; body?: string }][];
    expect(calls.map(([p, i]) => `${i.method} ${p}`)).toEqual([
      'PATCH /api/v1/scheduled-messages/s%2F1',
      'PATCH /api/v1/scheduled-messages/s-2',
      'DELETE /api/v1/scheduled-messages/s-3',
      'POST /api/v1/scheduled-messages/s-4/send',
    ]);
    expect(JSON.parse(calls[0][1].body!)).toEqual({ body: 'edited', sendAt: sendAt.toISOString() });
    expect(JSON.parse(calls[1][1].body!)).toEqual({ body: 'text only' });
  });
});

describe('useComposerSchedule', () => {
  it('schedules from a composer, confirms with a toast that opens the list, and counts what is scheduled here', async () => {
    const { qc, wrapper, where } = setup();
    qc.setQueryData(queryKeys.scheduledMessages(), [sm(), sm({ id: 's-2', parentMessageID: 'root' })]);
    vi.mocked(apiFetch).mockResolvedValue(sm());
    const { result } = renderHook(() => useComposerSchedule({ parentID: 'ch-1', parentType: 'channel' }), { wrapper });
    expect(result.current.scheduledCount).toBe(1);
    await act(() => result.current.onSchedule({ body: 'hi', attachmentIDs: [] }, new Date(Date.now() + 3_600_000)));
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Scheduled for /), 'success', expect.any(Object));
    act(() => toast.mock.calls[0][2].onActivate());
    expect(where.path).toBe('/drafts?tab=scheduled');
  });

  it('says so when scheduling fails, and keeps the composer\'s text (rejects)', async () => {
    const { wrapper } = setup();
    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useComposerSchedule({ parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root' }), { wrapper });
    await expect(result.current.onSchedule({ body: 'hi', attachmentIDs: [] }, new Date())).rejects.toThrow('offline');
    expect(toast).toHaveBeenCalledWith("Couldn't schedule the message — please try again.");
  });
});
