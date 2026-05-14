import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { render } from 'vitest-browser-react';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  appendMessageToCache,
  updateMessageInCache,
  markMessageDeletedInCache,
  removeMessageFromCache,
  invalidateThreadBothScopes,
  resyncMessageCache,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  useToggleReaction,
  useSetPinned,
  useSetNoUnfurl,
  type MessageWindow,
  type MessagePageParam,
} from './useMessages';
import { queryKeys } from '@/lib/query-keys';
import type { Message } from '@/types';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

const msg = (overrides: Partial<Message> = {}): Message => ({
  id: 'm-1',
  parentID: 'ch-1',
  parentType: 'channel',
  authorID: 'u-1',
  body: 'hi',
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

function withInitialPage(items: Message[], options: Partial<MessageWindow> = {}): InfiniteData<MessageWindow, MessagePageParam> {
  return {
    pages: [{
      items,
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: items[0]?.id,
      oldestID: items[items.length - 1]?.id,
      ...options,
    }],
    pageParams: [{ kind: 'tail' }],
  };
}

describe('useMessages — cache patch helpers', () => {
  it('appendMessageToCache prepends the new message at the head page', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), withInitialPage([msg({ id: 'm-1' })]));
    appendMessageToCache(qc, 'ch-1', msg({ id: 'm-2', body: 'second' }));
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items[0].id).toBe('m-2');
    expect(data?.pages[0].newestID).toBe('m-2');
  });

  it('appendMessageToCache is a no-op when hasMoreNewer is true (deep-link mode)', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      queryKeys.channelMessages('ch-1'),
      withInitialPage([msg({ id: 'm-1' })], { hasMoreNewer: true }),
    );
    appendMessageToCache(qc, 'ch-1', msg({ id: 'm-2' }));
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items.map((m) => m.id)).toEqual(['m-1']);
  });

  it('appendMessageToCache deduplicates when the id already exists in head page', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), withInitialPage([msg({ id: 'm-1' })]));
    appendMessageToCache(qc, 'ch-1', msg({ id: 'm-1' }));
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items.length).toBe(1);
  });

  it('updateMessageInCache replaces a matching message and leaves others alone', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      queryKeys.channelMessages('ch-1'),
      withInitialPage([msg({ id: 'm-1', body: 'old' }), msg({ id: 'm-2' })]),
    );
    updateMessageInCache(qc, 'ch-1', msg({ id: 'm-1', body: 'new' }));
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items[0].body).toBe('new');
    expect(data?.pages[0].items[1].body).toBe('hi');
  });

  it('markMessageDeletedInCache clears body and reactions and sets deleted: true', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      queryKeys.channelMessages('ch-1'),
      withInitialPage([msg({ id: 'm-1', body: 'oops', reactions: { ':+1:': ['u-2'] } })]),
    );
    markMessageDeletedInCache(qc, 'ch-1', 'm-1');
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items[0].body).toBe('');
    expect(data?.pages[0].items[0].deleted).toBe(true);
  });

  it('removeMessageFromCache drops the matching message from the page', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      queryKeys.channelMessages('ch-1'),
      withInitialPage([msg({ id: 'm-1' }), msg({ id: 'm-2' })]),
    );
    removeMessageFromCache(qc, 'ch-1', 'm-1');
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items.map((m) => m.id)).toEqual(['m-2']);
  });

  it('invalidateThreadBothScopes calls invalidateQueries for channel and conversation', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    invalidateThreadBothScopes(qc, 'ch-1', 't-1');
    expect(spy.mock.calls.length).toBe(2);
  });
});

describe('useMessages — resync after reconnect', () => {
  it('catches up tail-mode chains by fetching with after= cursor', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), withInitialPage([msg({ id: 'm-1' })]));
    apiFetchMock.mockResolvedValue({
      items: [msg({ id: 'm-2', body: 'fresh' })],
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: 'm-2',
      oldestID: 'm-2',
    });
    await resyncMessageCache(qc);
    expect(apiFetchMock).toHaveBeenCalled();
    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/after=m-1/);
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items[0].id).toBe('m-2');
  });

  it('skips deep-linked chains where hasMoreNewer=true', async () => {
    const qc = new QueryClient();
    qc.setQueryData(
      queryKeys.channelMessages('ch-1'),
      withInitialPage([msg({ id: 'm-1' })], { hasMoreNewer: true }),
    );
    await resyncMessageCache(qc);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('tolerates API errors from a catchUp fetch', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), withInitialPage([msg({ id: 'm-1' })]));
    apiFetchMock.mockRejectedValue(new Error('network'));
    await resyncMessageCache(qc);
    // Cache untouched, no throw.
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items.length).toBe(1);
  });
});

function Trigger<T>({
  hook,
  vars,
}: {
  hook: () => { mutate: (v: T) => void };
  vars: T;
}) {
  const m = hook();
  return <button data-testid="trigger" onClick={() => m.mutate(vars)} />;
}

async function renderMutation<T>(
  hook: () => { mutate: (v: T) => void },
  vars: T,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={qc}>
      <Trigger hook={hook} vars={vars} />
    </QueryClientProvider>,
  );
  return { qc, screen };
}

describe('useMessages — REST mutations', () => {
  it('useSendMessage POSTs to /channels/:id/messages with body+parent+attachments defaults', async () => {
    apiFetchMock.mockResolvedValue(msg({ id: 'new' }));
    const { screen } = await renderMutation(
      () => useSendMessage({ channelId: 'ch-1' }),
      { body: 'hi' },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/messages');
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ body: 'hi', parentMessageID: '', attachmentIDs: [] });
  });

  it('useSendMessage routes to /conversations/:id/messages when conversationId is set', async () => {
    apiFetchMock.mockResolvedValue(msg({ id: 'new' }));
    const { screen } = await renderMutation(
      () => useSendMessage({ conversationId: 'cv-1' }),
      { body: 'hi' },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/cv-1/messages');
  });

  it('useEditMessage PATCHes /messages/:id with body and attachmentIDs', async () => {
    apiFetchMock.mockResolvedValue(msg({ id: 'm-1', body: 'new' }));
    const { screen } = await renderMutation(useEditMessage as never, {
      messageId: 'm-1',
      channelId: 'ch-1',
      body: 'new',
      attachmentIDs: ['a-1'],
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/messages/m-1');
    const init = apiFetchMock.mock.calls[0][1] as { method: string; body: string };
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ body: 'new', attachmentIDs: ['a-1'] });
  });

  it('useDeleteMessage DELETEs /messages/:id', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(useDeleteMessage as never, {
      messageId: 'm-1',
      conversationId: 'cv-1',
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/cv-1/messages/m-1');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('DELETE');
  });

  it('useToggleReaction POSTs /messages/:id/reactions with emoji', async () => {
    apiFetchMock.mockResolvedValue(msg({ id: 'm-1' }));
    const { screen } = await renderMutation(useToggleReaction as never, {
      messageId: 'm-1',
      channelId: 'ch-1',
      emoji: ':+1:',
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/messages/m-1/reactions');
  });

  it('useSetPinned PUTs /messages/:id/pinned with pinned flag', async () => {
    apiFetchMock.mockResolvedValue(msg({ id: 'm-1', pinned: true }));
    const { screen } = await renderMutation(useSetPinned as never, {
      messageId: 'm-1',
      channelId: 'ch-1',
      pinned: true,
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/messages/m-1/pinned');
    expect(JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({ pinned: true });
  });

  it('useSetNoUnfurl PUTs /messages/:id/no-unfurl with noUnfurl flag', async () => {
    apiFetchMock.mockResolvedValue(msg({ id: 'm-1' }));
    const { screen } = await renderMutation(useSetNoUnfurl as never, {
      messageId: 'm-1',
      channelId: 'ch-1',
      noUnfurl: true,
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/messages/m-1/no-unfurl');
  });
});
