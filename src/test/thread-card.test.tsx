import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadCard } from '@/components/threads/ThreadCard';
import { resetSeenCache, threadDeepLink, type ThreadSummary } from '@/hooks/useThreads';
import { isThreadInView, resetThreadScopeForTests } from '@/lib/thread-scope';
import type { Message } from '@/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const sendMutate = vi.fn();
// Invoke onSuccess like a real successful mutation so the onSuccess handler
// (which clears edit mode) is exercised.
const editMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) => {
  opts?.onSuccess?.();
});
vi.mock('@/hooks/useMessages', () => ({
  useSendMessage: () => ({ mutate: sendMutate, isPending: false }),
  useEditMessage: () => ({ mutate: editMutate, isPending: false }),
}));

const isMobileRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => isMobileRef.value }));

// Controllable draft state so we can drive both the "no draft" (else) and
// "draft present" (delete-on-send) arms of the reply handler, plus the
// draft-save path triggered by onDraftChange.
let mockDraft: { id: string; body: string; attachmentIDs?: string[] } | undefined;
const saveDraftMutate = vi.fn();
vi.mock('@/hooks/useDrafts', () => ({
  useDraftForScope: () => ({ data: mockDraft }),
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: saveDraftMutate }),
  // useSendMessage owns the send-side draft lifecycle now.
  condemnDraftForSend: vi.fn(() => vi.fn()),
  removeDraftScopeFromCache: vi.fn(),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ isOnline: () => false, online: new Set<string>(), setUserOnline: () => undefined }),
}));

// Stub MessageItem to a tiny, easily-asserted element. ThreadCard only
// hands it a Message prop; verifying it received the right body keeps
// these tests focused on slicing/collapse logic, not on MessageItem
// internals (which have their own thorough suite).
vi.mock('@/components/chat/MessageItem', () => ({
  MessageItem: ({
    message,
    onEditMessage,
    disableEditing,
    authorUserStatus,
  }: {
    message: Message;
    onEditMessage?: (m: Message) => void;
    disableEditing?: boolean;
    authorUserStatus?: { emoji: string; text: string };
  }) => (
    <div
      data-testid="thread-card-msg"
      data-msg-id={message.id}
      data-disable-editing={disableEditing ? 'true' : 'false'}
      data-author-status={authorUserStatus?.emoji ?? ''}
    >
      {message.body}
      {onEditMessage && (
        <button data-testid={`edit-${message.id}`} onClick={() => onEditMessage(message)}>
          edit
        </button>
      )}
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
    editMutate.mockClear();
    isMobileRef.value = false;
    saveDraftMutate.mockReset();
    mockDraft = undefined;
    localStorage.clear();
    resetSeenCache();
    resetThreadScopeForTests();
    lastMessageInputProps.current = null;
    // Default: useUsersBatch sees /api/v1/users/batch — return [].
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/users/batch')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  });

  it('registers the thread as being read while the card is in view, and unregisters on unmount (SPEC D-3)', () => {
    // jsdom has no IntersectionObserver → useLiveInView falls back to
    // in-view, so mounting registers and unmounting must unregister.
    const { unmount } = renderCard(makeSummary());
    expect(isThreadInView('msg-root')).toBe(true);
    unmount();
    expect(isThreadInView('msg-root')).toBe(false);
  });

  it('renders the title as a link to the deep-link target', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
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

  it('marks the thread seen when the title link is clicked', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root', 'root')]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    const link = await screen.findByTestId('thread-card-title');

    fireEvent.click(link);

    // markThreadSeen persists the seen watermark server-side for the parent.
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/v1/user-state/threads/channels/ch-1/msg-root/seen',
        { method: 'PUT' },
      );
    });
  });

  it('routes files dropped on the card into the reply composer upload pipeline', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root', 'root')]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    await screen.findByTestId('thread-card-msg');

    // The card wires MessageDropZone.onFiles to inputRef.current.uploadFiles.
    // The MessageInput stub receives the card's ref as a prop (React 19
    // refs-as-props); install an upload spy on it like the real composer's
    // imperative handle would.
    const uploadFiles = vi.fn();
    const composerRef = lastMessageInputProps.current!.ref as { current: unknown };
    composerRef.current = { uploadFiles };

    const file = new File(['x'], 'diagram.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('thread-card-msg'), {
      dataTransfer: { types: ['Files'], files: [file] },
    });

    expect(uploadFiles).toHaveBeenCalledWith([file]);
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

  it('keeps the reply count on one line (nowrap + no shrink) so mobile headers cannot wrap it', async () => {
    apiFetchMock.mockResolvedValue([]);
    renderCard(makeSummary({ replyCount: 4 }));
    const label = await screen.findByText('4 replies');
    // The header squeeze must fall on the truncating title, never wrap this
    // label onto two rows (mobile /threads regression).
    expect(label.className).toContain('whitespace-nowrap');
    expect(label.className).toContain('shrink-0');
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

  it('replies without any view-side draft bookkeeping (useSendMessage owns the lifecycle)', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) return Promise.resolve([makeMessage('msg-root')]);
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    fireEvent.change(await screen.findByTestId('reply-body'), { target: { value: 'reply' } });
    fireEvent.click(screen.getByLabelText('Send reply'));
    // The card only reports the send event; draft condemnation/cache patching
    // happens inside useSendMessage (covered by the useMessages suites).
    expect(sendMutate).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'reply', parentMessageID: 'msg-root' }),
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
    editMutate.mockClear();
    sendMutate.mockReset();
    isMobileRef.value = false;
    lastMessageInputProps.current = null;
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
    } else {
      // jsdom has no IntersectionObserver: REMOVE the stub rather than
      // leaving it installed — a leaked never-firing observer makes every
      // later describe's cards permanently "not in view".
      delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
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

  // Regression: #85 ("Mobile fixes 3") slapped `disableEditing` on the card's
  // MessageItems, which silently killed editing on /threads for BOTH desktop
  // and mobile. The card must NOT disable editing.
  it('does not disable editing on its messages (the /threads edit regression)', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([{ ...makeMessage('msg-root', 'root'), authorID: 'u-me' }]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    await Promise.resolve();
    act(() => {
      FakeObserver.instances[0].fire(true);
    });
    const msgs = await screen.findAllByTestId('thread-card-msg');
    for (const m of msgs) {
      expect(m.getAttribute('data-disable-editing')).toBe('false');
    }
  });

  it('edits a thread reply via the card composer on mobile (body-only, preserving attachments)', async () => {
    isMobileRef.value = true;
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([
          { ...makeMessage('msg-root', 'root'), authorID: 'u-me' },
          { ...makeMessage('r0', 'old body'), authorID: 'u-me', parentID: 'ch-1', parentMessageID: 'msg-root' },
        ]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary({ replyCount: 1 }));
    await Promise.resolve();
    act(() => {
      FakeObserver.instances[0].fire(true);
    });
    // Mobile routes the edit to the card's bottom composer (inline is cramped
    // behind the keyboard), so clicking edit flips the composer into edit mode.
    const editBtn = await screen.findByTestId('edit-r0');
    act(() => {
      editBtn.click();
    });
    await waitFor(() => {
      expect(lastMessageInputProps.current?.initialBody).toBe('old body');
      expect(lastMessageInputProps.current?.submitLabel).toBe('Save');
    });
    const onSend = lastMessageInputProps.current!.onSend as (v: { body: string; attachmentIDs: string[] }) => void;
    act(() => {
      onSend({ body: 'edited body', attachmentIDs: [] });
    });
    expect(editMutate).toHaveBeenCalledTimes(1);
    const [vars] = editMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(vars).toMatchObject({ messageId: 'r0', body: 'edited body', channelId: 'ch-1' });
    // Body-only: NO attachmentIDs key, so the server preserves the originals
    // rather than stripping them.
    expect(vars).not.toHaveProperty('attachmentIDs');
  });

  it('an unchanged or empty edit just closes the editor without mutating', async () => {
    isMobileRef.value = true;
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([{ ...makeMessage('msg-root', 'root'), authorID: 'u-me' }]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    await Promise.resolve();
    act(() => {
      FakeObserver.instances[0].fire(true);
    });
    const editBtn = await screen.findByTestId('edit-msg-root');
    act(() => {
      editBtn.click();
    });
    await waitFor(() => expect(lastMessageInputProps.current?.submitLabel).toBe('Save'));
    // Same body → no-op early return, editor closes (back to reply mode).
    act(() => {
      (lastMessageInputProps.current!.onSend as (v: { body: string; attachmentIDs: string[] }) => void)({
        body: 'root',
        attachmentIDs: [],
      });
    });
    await waitFor(() => expect(lastMessageInputProps.current?.submitLabel).toBeUndefined());
    expect(editMutate).not.toHaveBeenCalled();

    // Re-open and submit a blank body → also a no-op close.
    act(() => {
      editBtn.click();
    });
    await waitFor(() => expect(lastMessageInputProps.current?.submitLabel).toBe('Save'));
    act(() => {
      (lastMessageInputProps.current!.onSend as (v: { body: string; attachmentIDs: string[] }) => void)({
        body: '   ',
        attachmentIDs: [],
      });
    });
    await waitFor(() => expect(lastMessageInputProps.current?.submitLabel).toBeUndefined());
    expect(editMutate).not.toHaveBeenCalled();
  });

  it('cancelling an edit returns the composer to reply mode', async () => {
    isMobileRef.value = true;
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([{ ...makeMessage('msg-root', 'root'), authorID: 'u-me' }]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    await Promise.resolve();
    act(() => {
      FakeObserver.instances[0].fire(true);
    });
    const editBtn = await screen.findByTestId('edit-msg-root');
    act(() => {
      editBtn.click();
    });
    await waitFor(() => expect(lastMessageInputProps.current?.onCancel).toBeTruthy());
    act(() => {
      (lastMessageInputProps.current!.onCancel as () => void)();
    });
    await waitFor(() => expect(lastMessageInputProps.current?.submitLabel).toBeUndefined());
    expect(editMutate).not.toHaveBeenCalled();
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

describe('ThreadCard author custom status', () => {
  it('passes the batch-resolved userStatus through to every message row', async () => {
    // /threads authors resolve via /users/batch — the custom status must
    // ride along or thread rows silently lose it (the reported bug).
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root', 'root')]);
      }
      if (url.includes('/users/batch')) {
        return Promise.resolve([
          { id: 'u-1', displayName: 'Rootine', userStatus: { emoji: '🌴', text: 'On vacation' } },
        ]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    await waitFor(() => {
      const rows = screen.getAllByTestId('thread-card-msg');
      expect(rows.some((r) => r.getAttribute('data-author-status') === '🌴')).toBe(true);
    });
  });
});
