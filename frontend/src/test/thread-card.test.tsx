import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadCard } from '@/components/threads/ThreadCard';
import { resetSeenCache, threadDeepLink, type ThreadSummary } from '@/hooks/useThreads';
import type { Message } from '@/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const sendMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useSendMessage: () => ({ mutate: sendMutate, isPending: false }),
}));

// Controllable draft state so we can drive both the "no draft" (else) and
// "draft present" (delete-on-send) arms of the reply handler, plus the
// draft-save path triggered by onDraftChange.
let mockDraft: { id: string; body: string; attachmentIDs?: string[] } | undefined;
const saveDraftMutate = vi.fn();
const clearDraftMutate = vi.fn();
vi.mock('@/hooks/useDrafts', () => ({
  useDraftForScope: () => ({ data: mockDraft }),
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: saveDraftMutate }),
  useClearDraftForScope: () => ({ mutate: clearDraftMutate }),
  restoreDraftScope: vi.fn(),
  restoreDraftScopeForContent: vi.fn(),
  suppressSentDraft: vi.fn(),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ isOnline: () => false, online: new Set<string>(), setUserOnline: () => undefined }),
}));

// Stub MessageItem to a tiny, easily-asserted element. ThreadCard only
// hands it a Message prop; verifying it received the right body keeps
// these tests focused on slicing/collapse logic, not on MessageItem
// internals (which have their own thorough suite).
vi.mock('@/components/chat/MessageItem', () => ({
  MessageItem: ({ message }: { message: Message }) => (
    <div data-testid="thread-card-msg" data-msg-id={message.id}>
      {message.body}
    </div>
  ),
}));

// Stub MessageInput similarly — a plain Send button that pipes the body
// into onSend so the reply-composer test can drive it without dealing
// with the WYSIWYG editor.
const lastMessageInputProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: ({
    onSend,
    disabled,
    focusKey,
    ...props
  }: {
    onSend: (v: { body: string; attachmentIDs: string[] }) => void;
    disabled?: boolean;
    focusKey?: string;
  } & Record<string, unknown>) => {
    lastMessageInputProps.current = { ...props, onSend, disabled, focusKey };
    return (
      <div data-focus-key={focusKey ?? ''}>
        <textarea aria-label="Reply body" data-testid="reply-body" disabled={disabled} />
        <button
          type="button"
          aria-label="Send reply"
          disabled={disabled}
          onClick={() => {
            const ta = document.querySelector('[data-testid="reply-body"]') as HTMLTextAreaElement;
            onSend({ body: ta.value, attachmentIDs: [] });
          }}
        >
          Send
        </button>
      </div>
    );
  },
}));

function makeSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    parentID: 'ch-1',
    parentType: 'channel',
    threadRootID: 'msg-root',
    rootAuthorID: 'u-1',
    rootBody: 'root',
    rootCreatedAt: '2026-04-26T10:00:00Z',
    replyCount: 0,
    latestActivityAt: '2026-04-26T10:00:00Z',
    ...overrides,
  };
}

function makeMessage(id: string, body = `body-${id}`): Message {
  return {
    id,
    parentID: 'ch-1',
    authorID: 'u-1',
    body,
    createdAt: '2026-04-26T10:00:00Z',
  };
}

function renderCard(summary: ThreadSummary) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ThreadCard
          summary={summary}
          title="~general"
          deepLink="/channel/general?thread=msg-root#msg-msg-root"
          currentUserId="u-me"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ThreadCard', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    sendMutate.mockReset();
    saveDraftMutate.mockReset();
    clearDraftMutate.mockReset();
    mockDraft = undefined;
    localStorage.clear();
    resetSeenCache();
    lastMessageInputProps.current = null;
    // Default: useUsersBatch sees /api/v1/users/batch — return [].
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/users/batch')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  });

  it('renders the title as a link to the deep-link target', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/channels/ch-1/messages/msg-root/thread') {
        return Promise.resolve([makeMessage('msg-root', 'root')]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    const link = await screen.findByTestId('thread-card-title');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/channel/general?thread=msg-root#msg-msg-root');
    expect(link.textContent).toBe('~general');
    expect(link).toHaveClass('text-sm');
    expect(link).toHaveClass('font-semibold');
    // Clip (not overflow-hidden via `truncate`) so the desktop webview doesn't
    // trap wheel events over the channel name and block page scroll.
    expect(link).toHaveClass('overflow-clip');
    expect(link).not.toHaveClass('truncate');
    expect(link).not.toHaveClass('hover:underline');
    expect(link).not.toHaveClass('text-link');
  });

  it('renders root + all replies when the thread is below the collapse threshold', async () => {
    // 1 root + 5 replies = 6 messages, well under the 10-cap.
    const messages = [
      makeMessage('msg-root', 'root'),
      ...Array.from({ length: 5 }, (_, i) => makeMessage(`r${i}`, `reply-${i}`)),
    ];
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) return Promise.resolve(messages);
      return Promise.resolve([]);
    });
    renderCard(makeSummary({ replyCount: 5 }));
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-card-msg')).toHaveLength(6);
    });
    expect(screen.queryByTestId('thread-card-expand')).toBeNull();
  });

  it('collapses long threads to root + last 2 replies + a "Show N more replies" toggle', async () => {
    // 1 root + 12 replies = 13 messages, over the 10-cap. Replies = 12,
    // tail = 2, hidden = 10.
    const messages = [
      makeMessage('msg-root', 'root'),
      ...Array.from({ length: 12 }, (_, i) => makeMessage(`r${i}`, `reply-${i}`)),
    ];
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) return Promise.resolve(messages);
      return Promise.resolve([]);
    });
    renderCard(makeSummary({ replyCount: 12 }));
    await waitFor(() => {
      // Root + last 2 replies = 3 messages visible.
      expect(screen.getAllByTestId('thread-card-msg')).toHaveLength(3);
    });
    const toggle = screen.getByTestId('thread-card-expand');
    expect(toggle.textContent).toMatch(/Show 10 more replies/);

    // Expanding reveals everything.
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-card-msg')).toHaveLength(13);
    });
    expect(screen.queryByTestId('thread-card-expand')).toBeNull();
  });

  it('uses singular "1 reply" for thread with exactly one reply', async () => {
    const messages = [makeMessage('msg-root', 'root'), makeMessage('r0', 'reply')];
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) return Promise.resolve(messages);
      return Promise.resolve([]);
    });
    renderCard(makeSummary({ replyCount: 1 }));
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-card-msg')).toHaveLength(2);
    });
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  it('reply composer posts as a thread reply with parentMessageID set', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root')]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());

    const ta = await screen.findByTestId('reply-body');
    fireEvent.change(ta, { target: { value: 'a quick reply' } });
    fireEvent.click(screen.getByLabelText('Send reply'));

    expect(sendMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'a quick reply',
        parentMessageID: 'msg-root',
      }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it('saves a draft via onDraftChange, defaulting missing attachmentIDs to []', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) return Promise.resolve([makeMessage('msg-root')]);
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    await screen.findByTestId('reply-body');
    const onDraftChange = lastMessageInputProps.current!.onDraftChange as (
      i: { body: string; attachmentIDs?: string[] },
      options?: { notify?: boolean },
    ) => void;
    // A keystroke save (no notify) must persist SILENTLY so the /threads
    // draft indicator doesn't surface mid-typing.
    act(() => onDraftChange({ body: 'wip', attachmentIDs: ['a-1'] }));
    expect(saveDraftMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        parentID: 'ch-1',
        parentType: 'channel',
        parentMessageID: 'msg-root',
        body: 'wip',
        attachmentIDs: ['a-1'],
        silent: true,
      }),
    );
    // Omitting attachmentIDs exercises the `?? []` fallback.
    act(() => onDraftChange({ body: 'wip2' }));
    expect(saveDraftMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'wip2', attachmentIDs: [], silent: true }),
    );
    // The focus-loss flush (notify) is what surfaces the draft.
    act(() => onDraftChange({ body: 'wip3' }, { notify: true }));
    expect(saveDraftMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'wip3', silent: false }),
    );
  });

  it('clears the draft scope after a successful reply', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) return Promise.resolve([makeMessage('msg-root')]);
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    fireEvent.change(await screen.findByTestId('reply-body'), { target: { value: 'reply' } });
    fireEvent.click(screen.getByLabelText('Send reply'));
    // send.mutate gets an onSuccess that clears the draft by SCOPE (so a
    // silently-saved draft whose id was never cached is cleared too).
    expect(sendMutate).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'reply', parentMessageID: 'msg-root' }),
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    const opts = sendMutate.mock.calls[0][1] as { onSuccess: () => void };
    act(() => opts.onSuccess());
    expect(clearDraftMutate).toHaveBeenCalledWith(
      expect.objectContaining({ parentType: 'channel', parentMessageID: 'msg-root' }),
    );
  });

  it('offers to add a mentioned non-member after replying in a channel thread', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root')]);
      }
      // No members / no channel list → the mentioned user is a non-member.
      return Promise.resolve([]);
    });
    renderCard(makeSummary());

    fireEvent.change(await screen.findByTestId('reply-body'), {
      target: { value: 'ping @[u-out|Outsider] take a look' },
    });
    fireEvent.click(screen.getByLabelText('Send reply'));

    const prompt = await screen.findByTestId('non-member-invite');
    expect(prompt).toHaveTextContent('Outsider');
    expect(screen.getByRole('button', { name: /Add to channel/i })).toBeInTheDocument();
  });

  it('never offers an invite for a conversation (DM) thread', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/thread')) return Promise.resolve([makeMessage('msg-root')]);
      return Promise.resolve([]);
    });
    renderCard(makeSummary({ parentID: 'conv-1', parentType: 'conversation' }));

    fireEvent.change(await screen.findByTestId('reply-body'), {
      target: { value: 'ping @[u-out|Outsider]' },
    });
    fireEvent.click(screen.getByLabelText('Send reply'));

    // A microtask flush is enough for any state update to land.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('non-member-invite')).toBeNull();
  });

  it('posting a reply marks the thread seen so the sidebar dot drops', async () => {
    const summary = makeSummary({ latestActivityAt: '2099-01-01T00:00:00.000Z' });
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root')]);
      }
      return Promise.resolve([]);
    });
    renderCard(summary);
    fireEvent.change(await screen.findByTestId('reply-body'), {
      target: { value: 'reply' },
    });
    fireEvent.click(screen.getByLabelText('Send reply'));

    const seen = JSON.parse(localStorage.getItem('ex.threads.seen.v1') ?? '{}');
    expect(seen['msg-root']).toBe(summary.latestActivityAt);
  });

  it('does not pass focusKey to the inline /threads composer', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root')]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    const replyBody = await screen.findByTestId('reply-body');
    expect(replyBody.closest('[data-focus-key]')?.getAttribute('data-focus-key')).toBe('');
  });

  it('uses the same thread-aware MessageInput context as the thread panel composer', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root')]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    await screen.findByTestId('reply-body');

    expect(lastMessageInputProps.current).toMatchObject({
      typingParentID: 'ch-1',
      typingParentType: 'channel',
      typingThreadRootID: 'msg-root',
      hideCodeButton: true,
    });
  });

  it('unfollows the thread from the /threads card header', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root')]);
      }
      return Promise.resolve(undefined);
    });
    renderCard(makeSummary());
    fireEvent.click(await screen.findByLabelText('Unfollow thread'));
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/v1/threads/channels/ch-1/msg-root/follow',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('shows unread state in the header', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root')]);
      }
      return Promise.resolve([]);
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ThreadCard
            summary={makeSummary()}
            title="~general"
            deepLink="/channel/general?thread=msg-root#msg-msg-root"
            currentUserId="u-me"
            unread
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('thread-card-unread')).toHaveTextContent('Unread');
    expect(screen.getByTestId('thread-card')).toHaveAttribute('data-unread', 'true');
  });
});

describe('ThreadCard — viewport gating', () => {
  // Install a controllable IntersectionObserver stub for this block so
  // we can verify fetches are deferred until the card scrolls in. The
  // outer suite leaves IO undefined, which exercises the fallback
  // (inView=true) — that's still the behavior in the rest of the
  // tests.
  class FakeObserver {
    static instances: FakeObserver[] = [];
    cb: IntersectionObserverCallback;
    observed: Element[] = [];
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
      FakeObserver.instances.push(this);
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    unobserve() {
      /* no-op */
    }
    disconnect() {
      this.observed = [];
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    fire(intersecting: boolean) {
      const entries = this.observed.map(
        (target) => ({ target, isIntersecting: intersecting }) as IntersectionObserverEntry,
      );
      this.cb(entries, this as unknown as IntersectionObserver);
    }
  }

  let originalIO: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    localStorage.clear();
    resetSeenCache();
    originalIO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    FakeObserver.instances = [];
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      value: FakeObserver,
      configurable: true,
      writable: true,
    });
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/users/batch')) return Promise.resolve([]);
      return Promise.resolve([makeMessage('msg-root', 'root')]);
    });
  });

  afterEach(() => {
    if (originalIO) {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        value: originalIO,
        configurable: true,
        writable: true,
      });
    }
  });

  it('does not fetch the thread until the card scrolls into view', async () => {
    renderCard(makeSummary());
    // Microtasks flush — but nothing should hit the thread endpoint.
    await Promise.resolve();
    const threadCalls = apiFetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/messages/msg-root/thread'),
    );
    expect(threadCalls.length).toBe(0);
  });

  it('fetches the thread once the IntersectionObserver fires intersecting=true', async () => {
    renderCard(makeSummary());
    await Promise.resolve();
    act(() => {
      FakeObserver.instances[0].fire(true);
    });
    await waitFor(() => {
      const threadCalls = apiFetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/messages/msg-root/thread'),
      );
      expect(threadCalls.length).toBe(1);
    });
  });

  it('marks an unread thread read when the card enters the viewport', async () => {
    const summary = makeSummary({ latestActivityAt: '2099-01-01T00:00:00.000Z' });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ThreadCard
            summary={summary}
            title="~general"
            deepLink="/channel/general?thread=msg-root#msg-msg-root"
            currentUserId="u-me"
            unread
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await Promise.resolve();
    act(() => {
      FakeObserver.instances[0].fire(true);
    });
    await waitFor(() => {
      const threadCalls = apiFetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/messages/msg-root/thread'),
      );
      expect(threadCalls.length).toBe(1);
    });
    const seen = JSON.parse(localStorage.getItem('ex.threads.seen.v1') ?? '{}');
    expect(seen['msg-root']).toBe(summary.latestActivityAt);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/v1/user-state/threads/channels/ch-1/msg-root/seen',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('does not mark a read thread again when the card enters the viewport', async () => {
    renderCard(makeSummary());
    await Promise.resolve();
    act(() => {
      FakeObserver.instances[0].fire(true);
    });
    await waitFor(() => {
      const threadCalls = apiFetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('/messages/msg-root/thread'),
      );
      expect(threadCalls.length).toBe(1);
    });
    const seenCalls = apiFetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/user-state/threads/'),
    );
    expect(seenCalls).toHaveLength(0);
  });
});

describe('threadDeepLink', () => {
  it('builds a slug-based URL for channel threads', () => {
    const url = threadDeepLink(
      { parentID: 'ch-1', parentType: 'channel', threadRootID: 'r1' } as ThreadSummary,
      'general',
    );
    expect(url).toBe('/channel/general?thread=r1#msg-r1');
  });

  it('falls back to the channel id when the slug is unknown', () => {
    const url = threadDeepLink(
      { parentID: 'ch-X', parentType: 'channel', threadRootID: 'r1' } as ThreadSummary,
      '',
    );
    expect(url).toBe('/channel/ch-X?thread=r1#msg-r1');
  });

  it('builds an id-based URL for conversation threads', () => {
    const url = threadDeepLink(
      { parentID: 'conv-1', parentType: 'conversation', threadRootID: 'r1' } as ThreadSummary,
      '',
    );
    expect(url).toBe('/conversation/conv-1?thread=r1#msg-r1');
  });

  it('includes a #msg-<rootID> fragment so the message highlights AND the thread panel opens', () => {
    // Regression: the `?thread=...` query alone opens the panel but
    // doesn't scroll/flash the root in the message list. Both signals
    // must travel together so clicking a thread title feels like a
    // proper "jump to thread".
    const url = threadDeepLink(
      { parentID: 'ch-1', parentType: 'channel', threadRootID: 'rootABC' } as ThreadSummary,
      'general',
    );
    expect(url).toMatch(/\?thread=rootABC/);
    expect(url).toMatch(/#msg-rootABC$/);
  });
});
