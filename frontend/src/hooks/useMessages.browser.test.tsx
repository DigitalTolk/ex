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
  patchMessageInThreadCache,
  resyncMessageCache,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  useToggleReaction,
  useSetPinned,
  useSetNoUnfurl,
  useChannelMessages,
  useConversationMessages,
  useSendChannelMessage,
  useSendConversationMessage,
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
  it('appendMessageToCache prepends the new message at the head page (returns true)', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), withInitialPage([msg({ id: 'm-1' })]));
    expect(appendMessageToCache(qc, 'ch-1', msg({ id: 'm-2', body: 'second' }))).toBe(true);
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items[0].id).toBe('m-2');
    expect(data?.pages[0].newestID).toBe('m-2');
  });

  it('appendMessageToCache is a no-op returning false when hasMoreNewer (deep-link mode)', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      queryKeys.channelMessages('ch-1'),
      withInitialPage([msg({ id: 'm-1' })], { hasMoreNewer: true }),
    );
    expect(appendMessageToCache(qc, 'ch-1', msg({ id: 'm-2' }))).toBe(false);
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items.map((m) => m.id)).toEqual(['m-1']);
  });

  it('appendMessageToCache deduplicates (returns true) when the id already exists', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), withInitialPage([msg({ id: 'm-1' })]));
    expect(appendMessageToCache(qc, 'ch-1', msg({ id: 'm-1' }))).toBe(true);
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

  it('patchMessageInThreadCache replaces the message in a populated thread cache (and no-ops when empty)', () => {
    const qc = new QueryClient();
    // Populated channel-scope thread cache → the message is replaced in place.
    qc.setQueryData(queryKeys.thread('channels/ch-1', 'root-1'), [
      msg({ id: 'root-1' }),
      msg({ id: 'reply-1', body: 'before' }),
    ]);
    patchMessageInThreadCache(qc, 'ch-1', 'root-1', msg({ id: 'reply-1', body: 'after', reactions: { ':tada:': ['u-2'] } }));
    const thread = qc.getQueryData<Message[]>(queryKeys.thread('channels/ch-1', 'root-1'));
    expect(thread?.find((m) => m.id === 'reply-1')?.body).toBe('after');
    expect(thread?.find((m) => m.id === 'reply-1')?.reactions).toEqual({ ':tada:': ['u-2'] });
    // The conversation-scope key was never populated → the updater hits the
    // undefined branch and leaves it untouched.
    expect(qc.getQueryData(queryKeys.thread('conversations/ch-1', 'root-1'))).toBeUndefined();
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
  it('useSendMessage jumps to the tail (resetQueries) when the sender is deep-linked mid-history', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Deep-link window: head still has newer pages, so the just-sent message
    // can't be appended and must trigger a reset-to-tail.
    qc.setQueryData(
      queryKeys.channelMessages('ch-1'),
      withInitialPage([msg({ id: 'm-old' })], { hasMoreNewer: true }),
    );
    const resetSpy = vi.spyOn(qc, 'resetQueries');
    apiFetchMock.mockResolvedValue(msg({ id: 'sent' }));
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger hook={() => useSendMessage({ channelId: 'ch-1' })} vars={{ body: 'hi' }} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(resetSpy).toHaveBeenCalled());
  });

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
    expect(body).toMatchObject({ body: 'hi', parentMessageID: '', attachmentIDs: [] });
    // The send carries clientTs so the server folds the draft-clear into it.
    expect(body.clientTs).toBeGreaterThan(0);
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

describe('useMessages — conversation-scope mutations (?? right-hand sides)', () => {
  // Each mutation's onSuccess computes `vars.channelId ?? vars.conversationId`.
  // Driving them with conversationId-only vars exercises the right-hand
  // ?? arm (lines 366, 399, 415, 434) plus the conversationId path in
  // invalidatePinnedList (lines 367, 400, 416, 435) and messagePath
  // (line 32).
  it('useEditMessage updates a conversation message and omits attachmentIDs when undefined', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      queryKeys.conversationMessages('cv-1'),
      withInitialPage([msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation', body: 'old' })]),
    );
    apiFetchMock.mockResolvedValue(msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation', body: 'new' }));
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger hook={useEditMessage as never} vars={{ messageId: 'm-1', conversationId: 'cv-1', body: 'new' }} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    // No attachmentIDs key in the PATCH body (line 359 false arm).
    const init = apiFetchMock.mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ body: 'new' });
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.conversationMessages('cv-1'));
    expect(data?.pages[0].items[0].body).toBe('new');
  });

  it('useDeleteMessage marks a conversation message deleted in cache', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      queryKeys.conversationMessages('cv-1'),
      withInitialPage([msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation' })]),
    );
    apiFetchMock.mockResolvedValue(undefined);
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger hook={useDeleteMessage as never} vars={{ messageId: 'm-1', conversationId: 'cv-1' }} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.conversationMessages('cv-1'));
    expect(data?.pages[0].items[0].deleted).toBe(true);
  });

  it('useToggleReaction updates a conversation message in cache', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      queryKeys.conversationMessages('cv-1'),
      withInitialPage([msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation' })]),
    );
    apiFetchMock.mockResolvedValue(msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation', reactions: { ':+1:': ['u-1'] } }));
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger hook={useToggleReaction as never} vars={{ messageId: 'm-1', conversationId: 'cv-1', emoji: ':+1:' }} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.conversationMessages('cv-1'));
    expect(data?.pages[0].items[0].reactions).toEqual({ ':+1:': ['u-1'] });
  });

  it('useSetPinned updates a conversation message in cache', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      queryKeys.conversationMessages('cv-1'),
      withInitialPage([msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation' })]),
    );
    apiFetchMock.mockResolvedValue(msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation', pinned: true }));
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger hook={useSetPinned as never} vars={{ messageId: 'm-1', conversationId: 'cv-1', pinned: true }} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.conversationMessages('cv-1'));
    expect(data?.pages[0].items[0].pinned).toBe(true);
  });

  it('useSetNoUnfurl updates a conversation message in cache', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      queryKeys.conversationMessages('cv-1'),
      withInitialPage([msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation' })]),
    );
    apiFetchMock.mockResolvedValue(msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation', noUnfurl: true }));
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger hook={useSetNoUnfurl as never} vars={{ messageId: 'm-1', conversationId: 'cv-1', noUnfurl: true }} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.conversationMessages('cv-1'));
    expect(data?.pages[0].items[0].noUnfurl).toBe(true);
  });
});

describe('useMessages — useSendMessage thread-reply path', () => {
  async function sendReply(qc: QueryClient, vars: { body: string; parentMessageID: string }) {
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger hook={() => useSendMessage({ channelId: 'ch-1' })} vars={vars} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
  }

  it('leaves the main list untouched and refreshes userThreads (no thread cache to patch)', async () => {
    // parentMessageID set → no appendMessageToCache to the main list; with no
    // open thread query, the optimistic patch updater hits its `: old`
    // (undefined) arm and creates nothing, while userThreads still refreshes.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.channelMessages('ch-1'), withInitialPage([msg({ id: 'm-1' })]));
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    apiFetchMock.mockResolvedValue(msg({ id: 'reply', parentMessageID: 'root-1' }));
    await sendReply(qc, { body: 'a reply', parentMessageID: 'root-1' });

    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items.map((m) => m.id)).toEqual(['m-1']);
    expect(qc.getQueryData(queryKeys.thread('channels/ch-1', 'root-1'))).toBeUndefined();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.userThreads() });
    // The thread query itself is NOT invalidated (optimistic append is authoritative).
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.thread('channels/ch-1', 'root-1') });
  });

  it('optimistically appends the reply to an open thread', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = msg({ id: 'root-1', body: 'root' });
    qc.setQueryData<Message[]>(queryKeys.thread('channels/ch-1', 'root-1'), [root]);
    apiFetchMock.mockResolvedValue(msg({ id: 'reply', parentMessageID: 'root-1', body: 'a reply' }));
    await sendReply(qc, { body: 'a reply', parentMessageID: 'root-1' });

    expect(qc.getQueryData<Message[]>(queryKeys.thread('channels/ch-1', 'root-1'))?.map((m) => m.id))
      .toEqual(['root-1', 'reply']);
  });

  it('does not duplicate a reply already present in the open thread', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reply = msg({ id: 'reply', parentMessageID: 'root-1', body: 'a reply' });
    qc.setQueryData<Message[]>(queryKeys.thread('channels/ch-1', 'root-1'), [reply]);
    apiFetchMock.mockResolvedValue(reply);
    await sendReply(qc, { body: 'a reply', parentMessageID: 'root-1' });

    expect(qc.getQueryData<Message[]>(queryKeys.thread('channels/ch-1', 'root-1'))?.map((m) => m.id))
      .toEqual(['reply']);
  });
});

describe('useMessages — infinite query hooks', () => {
  function InfiniteProbe({
    scope,
    id,
    anchor,
  }: {
    scope: 'channel' | 'conversation';
    id: string | undefined;
    anchor?: string;
  }) {
    // Both hooks are called unconditionally (rules-of-hooks); the
    // inactive one is disabled because its id is undefined.
    const channelQuery = useChannelMessages(scope === 'channel' ? id : undefined, scope === 'channel' ? anchor : undefined);
    const conversationQuery = useConversationMessages(
      scope === 'conversation' ? id : undefined,
      scope === 'conversation' ? anchor : undefined,
    );
    const q = scope === 'channel' ? channelQuery : conversationQuery;
    const first = q.data?.pages[0];
    return <div data-testid="probe" data-count={first ? String(first.items.length) : 'none'} />;
  }

  it('useConversationMessages fetches the tail window for a conversation', async () => {
    apiFetchMock.mockResolvedValue({
      items: [msg({ id: 'm-1', parentID: 'cv-1', parentType: 'conversation' })],
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: 'm-1',
      oldestID: 'm-1',
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <InfiniteProbe scope="conversation" id="cv-1" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByTestId('probe').element().getAttribute('data-count')).toBe('1');
    });
    expect(apiFetchMock.mock.calls[0][0]).toMatch(/^\/api\/v1\/conversations\/cv-1\/messages\?/);
  });

  it('useChannelMessages with an anchor seeds an around-window deep-link fetch', async () => {
    apiFetchMock.mockResolvedValue({
      items: [msg({ id: 'anchor-msg' })],
      hasMoreOlder: true,
      hasMoreNewer: true,
      newestID: 'anchor-msg',
      oldestID: 'anchor-msg',
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <InfiniteProbe scope="channel" id="ch-1" anchor="anchor-msg" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByTestId('probe').element().getAttribute('data-count')).toBe('1');
    });
    expect(apiFetchMock.mock.calls[0][0]).toMatch(/around=anchor-msg/);
  });

  it('useConversationMessages stays idle (no fetch) when id is undefined', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <InfiniteProbe scope="conversation" id={undefined} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.getByTestId('probe').element().getAttribute('data-count')).toBe('none');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('useMessages — legacy send aliases', () => {
  it('useSendChannelMessage posts to the channel messages endpoint', async () => {
    apiFetchMock.mockResolvedValue(msg({ id: 'new' }));
    const { screen } = await renderMutation(() => useSendChannelMessage('ch-9'), { body: 'hey' });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-9/messages');
  });

  it('useSendConversationMessage posts to the conversation messages endpoint', async () => {
    apiFetchMock.mockResolvedValue(msg({ id: 'new', parentID: 'cv-9', parentType: 'conversation' }));
    const { screen } = await renderMutation(() => useSendConversationMessage('cv-9'), { body: 'hey' });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/cv-9/messages');
  });
});

describe('useMessages — messagePath guard', () => {
  it('useEditMessage rejects when neither channelId nor conversationId is set', async () => {
    // messagePath throws (line 33) → the mutation rejects. Assert the
    // mutation surfaces an error rather than calling apiFetch.
    function ErrProbe() {
      const m = useEditMessage();
      return (
        <button
          data-testid="trigger"
          data-error={m.isError ? '1' : '0'}
          onClick={() => m.mutate({ messageId: 'm-1', body: 'x' })}
        />
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <ErrProbe />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId('trigger').element().getAttribute('data-error')).toBe('1');
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
