import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadCard } from '@/components/threads/ThreadCard';
import { threadDeepLink, type ThreadSummary } from '@/hooks/useThreads';
import type { Message } from '@/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const sendMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useSendMessage: () => ({ mutate: sendMutate, isPending: false }),
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
vi.mock('@/components/chat/MessageInput', () => ({
  MessageInput: ({
    onSend,
    disabled,
  }: {
    onSend: (v: { body: string; attachmentIDs: string[] }) => void;
    disabled?: boolean;
  }) => (
    <div>
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
  ),
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
          title="#general"
          deepLink="/channel/general?thread=msg-root"
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
    localStorage.clear();
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
    expect(link.getAttribute('href')).toBe('/channel/general?thread=msg-root');
    expect(link.textContent).toBe('#general');
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
    );
  });

  it('posting a reply marks the thread seen so the sidebar dot drops', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('/messages/msg-root/thread')) {
        return Promise.resolve([makeMessage('msg-root')]);
      }
      return Promise.resolve([]);
    });
    renderCard(makeSummary());
    fireEvent.change(await screen.findByTestId('reply-body'), {
      target: { value: 'reply' },
    });
    fireEvent.click(screen.getByLabelText('Send reply'));

    const seen = JSON.parse(localStorage.getItem('ex.threads.seen.v1') ?? '{}');
    expect(seen['msg-root']).toBeDefined();
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
});

describe('threadDeepLink', () => {
  it('builds a slug-based URL for channel threads', () => {
    const url = threadDeepLink(
      { parentID: 'ch-1', parentType: 'channel', threadRootID: 'r1' } as ThreadSummary,
      'general',
    );
    expect(url).toBe('/channel/general?thread=r1');
  });

  it('falls back to the channel id when the slug is unknown', () => {
    const url = threadDeepLink(
      { parentID: 'ch-X', parentType: 'channel', threadRootID: 'r1' } as ThreadSummary,
      '',
    );
    expect(url).toBe('/channel/ch-X?thread=r1');
  });

  it('builds an id-based URL for conversation threads', () => {
    const url = threadDeepLink(
      { parentID: 'conv-1', parentType: 'conversation', threadRootID: 'r1' } as ThreadSummary,
      '',
    );
    expect(url).toBe('/conversation/conv-1?thread=r1');
  });
});
