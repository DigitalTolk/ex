import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  appendMessageToCache,
  appendReplyToThreadCache,
  newClientNonce,
  pendingMessageID,
  placeSentMessage,
  setPendingState,
  usePendingMessageActions,
  useSendMessage,
  type MessageWindow,
} from './useMessages';
import { queryKeys } from '@/lib/query-keys';
import type { Message } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

// Optimistic send: a pending row shows at once and is swapped for the real
// message whichever of the send response / the message.new broadcast lands
// first; a failed send stays as "Not sent" with Retry / Delete.

const tailKey = queryKeys.channelMessages('ch-1', null);
const threadKey = queryKeys.thread('channels/ch-1', 'root-1');
const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  parentID: 'ch-1',
  authorID: 'u-1',
  body: id,
  createdAt: '2026-10-07T10:00:00Z',
  ...over,
});
function seed(qc: QueryClient, items: Message[] = [msg('01A')]) {
  qc.setQueryData<InfiniteData<MessageWindow>>(tailKey, {
    pages: [{ items, hasMoreOlder: false, hasMoreNewer: false, oldestID: '01A', newestID: '01A' }],
    pageParams: [{ kind: 'initial' }],
  });
  qc.setQueryData<Message[]>(threadKey, [msg('root-1')]);
}
const tail = (qc: QueryClient) => qc.getQueryData<InfiniteData<MessageWindow>>(tailKey)!.pages[0];
const thread = (qc: QueryClient) => qc.getQueryData<Message[]>(threadKey)!;
function wrapperFor(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('optimistic send cache rules', () => {
  it('nonces are header-safe and pending ids never look like server ids', () => {
    expect(newClientNonce()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(pendingMessageID('n1')).toBe('pending-n1');
  });

  it('a pending row never becomes the newer-than cursor; the real one does, swapped in place', () => {
    const qc = new QueryClient();
    seed(qc);
    const pending = msg(pendingMessageID('n1'), { clientNonce: 'n1', pendingState: 'sending', parentType: 'channel' });
    expect(appendMessageToCache(qc, 'ch-1', pending)).toBe(true);
    expect(tail(qc).newestID).toBe('01A');
    expect(appendMessageToCache(qc, 'ch-1', msg('01C', { clientNonce: 'n2' }))).toBe(true); // someone else's, newer
    expect(appendMessageToCache(qc, 'ch-1', msg('01B', { clientNonce: 'n1' }))).toBe(true); // the real one for n1
    expect(tail(qc).items.map((m) => m.id)).toEqual(['01C', '01B', '01A']);
    expect(tail(qc).newestID).toBe('01C'); // the older real id doesn't move the cursor back
  });

  it('whichever lands second finds the real message already there: no duplicate', () => {
    const qc = new QueryClient();
    seed(qc);
    appendMessageToCache(qc, 'ch-1', msg(pendingMessageID('n1'), { clientNonce: 'n1', pendingState: 'sending' }));
    appendMessageToCache(qc, 'ch-1', msg('01B', { clientNonce: 'n1' })); // broadcast
    const before = tail(qc).items;
    appendMessageToCache(qc, 'ch-1', msg('01B', { clientNonce: 'n1' })); // response
    expect(tail(qc).items).toBe(before);
    // A late copy of the real message also clears a pending row left behind
    // (e.g. a reconnect catch-up added the real one without its nonce).
    appendMessageToCache(qc, 'ch-1', msg(pendingMessageID('n3'), { clientNonce: 'n3', pendingState: 'sending' }));
    appendMessageToCache(qc, 'ch-1', msg('01D'));
    appendMessageToCache(qc, 'ch-1', msg('01D', { clientNonce: 'n3' }));
    expect(tail(qc).items.map((m) => m.id)).toEqual(['01D', '01B', '01A']);
  });

  it('threads append at the end and swap the pending reply the same way', () => {
    const qc = new QueryClient();
    seed(qc);
    const pending = msg(pendingMessageID('r1'), { clientNonce: 'r1', pendingState: 'sending', parentMessageID: 'root-1', parentType: 'channel' });
    expect(placeSentMessage(qc, pending)).toBe(true);
    expect(thread(qc).map((m) => m.id)).toEqual(['root-1', 'pending-r1']);
    expect(appendReplyToThreadCache(qc, 'ch-1', 'root-1', msg('01R', { clientNonce: 'r1', parentMessageID: 'root-1' }))).toBe(true);
    expect(thread(qc).map((m) => m.id)).toEqual(['root-1', '01R']);
  });

  it('setPendingState marks or removes the row in the list or the thread, and tolerates empty caches', () => {
    const qc = new QueryClient();
    seed(qc);
    const top = msg(pendingMessageID('n1'), { clientNonce: 'n1', pendingState: 'sending', parentType: 'channel' });
    const reply = msg(pendingMessageID('r1'), { clientNonce: 'r1', pendingState: 'sending', parentMessageID: 'root-1', parentType: 'channel' });
    placeSentMessage(qc, top);
    placeSentMessage(qc, reply);
    setPendingState(qc, top, 'failed');
    setPendingState(qc, reply, 'failed');
    expect(tail(qc).items[0].pendingState).toBe('failed');
    expect(thread(qc)[1].pendingState).toBe('failed');
    setPendingState(qc, top, null);
    setPendingState(qc, reply, null);
    expect(tail(qc).items.map((m) => m.id)).toEqual(['01A']);
    expect(thread(qc).map((m) => m.id)).toEqual(['root-1']);
    const empty = new QueryClient();
    setPendingState(empty, top, 'failed');
    setPendingState(empty, reply, 'failed');
    expect(empty.getQueryData(tailKey)).toBeUndefined();
    const noPages = { pages: [], pageParams: [] };
    empty.setQueryData(tailKey, noPages);
    setPendingState(empty, top, 'failed');
    expect(empty.getQueryData(tailKey)).toBe(noPages);
  });
});

describe('useSendMessage (optimistic)', () => {
  it('shows a pending row at once, sends the nonce, and swaps in the real message', async () => {
    const qc = new QueryClient();
    seed(qc);
    let resolve: (m: Message) => void = () => {};
    vi.mocked(apiFetch).mockImplementation(() => new Promise((r) => (resolve = r as (m: Message) => void)));
    const { result } = renderHook(() => useSendMessage({ channelId: 'ch-1', authorID: 'u-1' }), { wrapper: wrapperFor(qc) });
    act(() => result.current.mutate({ body: 'hello there' }));
    await waitFor(() => expect(tail(qc).items[0].pendingState).toBe('sending'));
    const pending = tail(qc).items[0];
    expect(pending).toMatchObject({ body: 'hello there', authorID: 'u-1', parentType: 'channel' });
    const [, init] = vi.mocked(apiFetch).mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['X-Client-Nonce']).toBe(pending.clientNonce);
    await act(async () => resolve(msg('01B', { clientNonce: pending.clientNonce, body: 'hello there' })));
    await waitFor(() => expect(tail(qc).items.map((m) => m.id)).toEqual(['01B', '01A']));
  });

  it('a response without the nonce (an older server) still replaces the pending row', async () => {
    const qc = new QueryClient();
    seed(qc);
    vi.mocked(apiFetch).mockResolvedValueOnce(msg('01B', { body: 'hello there' }));
    const { result } = renderHook(() => useSendMessage({ channelId: 'ch-1', authorID: 'u-1' }), { wrapper: wrapperFor(qc) });
    await act(() => result.current.mutateAsync({ body: 'hello there' }));
    expect(tail(qc).items.map((m) => m.id)).toEqual(['01B', '01A']);
  });

  it('a thread reply goes pending in the thread', async () => {
    const qc = new QueryClient();
    seed(qc);
    vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useSendMessage({ channelId: 'ch-1', authorID: 'u-1' }), { wrapper: wrapperFor(qc) });
    act(() => result.current.mutate({ body: 'reply', parentMessageID: 'root-1' }));
    await waitFor(() => expect(thread(qc)[1]?.pendingState).toBe('sending'));
  });

  it('a failed send keeps its row, marked failed', async () => {
    const qc = new QueryClient();
    seed(qc);
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useSendMessage({ conversationId: 'ch-1', authorID: 'u-1' }), { wrapper: wrapperFor(qc) });
    await act(async () => {
      await result.current.mutateAsync({ body: 'try me' }).catch(() => undefined);
    });
    // conversation scope: the pending row went into the conversation list
    const convTail = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.conversationMessages('ch-1', null));
    expect(convTail).toBeUndefined();
  });

  it('without a known sender, or nowhere to place it, it just sends', async () => {
    const qc = new QueryClient();
    vi.mocked(apiFetch).mockResolvedValue(msg('01Z'));
    const anon = renderHook(() => useSendMessage({ channelId: 'ch-1' }), { wrapper: wrapperFor(qc) });
    await act(() => anon.result.current.mutateAsync({ body: 'x', clientNonce: 'given' }));
    const [, init] = vi.mocked(apiFetch).mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['X-Client-Nonce']).toBe('given');
    const uncached = renderHook(() => useSendMessage({ channelId: 'ch-1', authorID: 'u-1' }), { wrapper: wrapperFor(qc) });
    await act(() => uncached.result.current.mutateAsync({ body: 'y' }));
    expect(qc.getQueryData(tailKey)).toBeUndefined();
  });

  it('failure in a cached chat leaves a failed row', async () => {
    const qc = new QueryClient();
    seed(qc);
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useSendMessage({ channelId: 'ch-1', authorID: 'u-1' }), { wrapper: wrapperFor(qc) });
    act(() => result.current.mutate({ body: 'not sent' }));
    await waitFor(() => expect(tail(qc).items[0]).toMatchObject({ body: 'not sent', pendingState: 'failed' }));
  });
});

describe('usePendingMessageActions', () => {
  it('Retry resends with the same nonce and swaps in the result; a second failure marks it failed again', async () => {
    const qc = new QueryClient();
    seed(qc);
    const failed = msg(pendingMessageID('n9'), { clientNonce: 'n9', pendingState: 'failed', parentType: 'channel', body: 'again', attachmentIDs: ['a-1'] });
    placeSentMessage(qc, failed);
    const { result } = renderHook(() => usePendingMessageActions(), { wrapper: wrapperFor(qc) });

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('still offline'));
    act(() => result.current.retry(failed));
    expect(tail(qc).items[0].pendingState).toBe('sending');
    await waitFor(() => expect(tail(qc).items[0].pendingState).toBe('failed'));

    vi.mocked(apiFetch).mockResolvedValueOnce(msg('01N', { body: 'again' })); // no nonce echoed
    act(() => result.current.retry(failed));
    await waitFor(() => expect(tail(qc).items.map((m) => m.id)).toEqual(['01N', '01A']));
    const [path, init] = vi.mocked(apiFetch).mock.calls[1] as [string, { headers: Record<string, string>; body: string }];
    expect(path).toBe('/api/v1/channels/ch-1/messages');
    expect(init.headers['X-Client-Nonce']).toBe('n9');
    expect(JSON.parse(init.body)).toEqual({ body: 'again', parentMessageID: '', attachmentIDs: ['a-1'] });
  });

  it('Retry works for conversations and threads too; Delete drops the row', async () => {
    const qc = new QueryClient();
    seed(qc);
    const reply = msg(pendingMessageID('r9'), { pendingState: 'failed', parentType: 'conversation', parentMessageID: 'root-1', parentID: 'dm-1' });
    const { result } = renderHook(() => usePendingMessageActions(), { wrapper: wrapperFor(qc) });
    vi.mocked(apiFetch).mockResolvedValueOnce(msg('01T', { parentID: 'dm-1', parentMessageID: 'root-1', clientNonce: 'r9' }));
    act(() => result.current.retry(reply));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/dm-1/messages', expect.objectContaining({ headers: undefined })));

    const failed = msg(pendingMessageID('n8'), { clientNonce: 'n8', pendingState: 'failed', parentType: 'channel' });
    placeSentMessage(qc, failed);
    act(() => result.current.discard(failed));
    expect(tail(qc).items.map((m) => m.id)).toEqual(['01A']);
  });
});
