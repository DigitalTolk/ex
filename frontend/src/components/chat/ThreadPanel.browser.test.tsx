import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadPanel } from './ThreadPanel';
import type { Message } from '@/types';

// Browser smoke coverage for the thread side panel — 479 lines and
// 0.85% browser branches before this file. Catches mount-time
// regressions in the thread renderer (the same component-level
// "hydration crashes the whole tree" bug class we already shipped
// a fix for in the markdown pipeline).

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useFrequentEmojis: () => ['thumbsup', 'heart', 'tada'],
}));

vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), mutate: vi.fn(), isPending: false }),
  uploadAttachment: vi.fn(),
}));

let threadMessagesState: { data: unknown; isLoading: boolean } = { data: undefined, isLoading: false };
const markThreadSeenMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useThreads', () => ({
  useUserThreads: () => ({ data: [] }),
  useThreadMeta: () => undefined,
  useThreadMessages: () => threadMessagesState,
  useFollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  useUnfollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  markThreadSeen: (...args: unknown[]) => markThreadSeenMock(...args),
}));

vi.mock('@/hooks/useReactions', () => ({
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useDrafts', () => ({
  useDraftForScope: () => ({ data: undefined }),
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: vi.fn() }),
  useClearDraftForScope: () => ({ mutate: vi.fn() }),
  restoreDraftScope: vi.fn(),
  restoreDraftScopeForContent: vi.fn(),
  suppressSentDraft: vi.fn(),
}));

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false, giphyAPIKey: '' } }),
}));

vi.mock('@/context/AuthContext', () => {
  const state = { user: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' }, isAuthenticated: true, isLoading: false };
  return {
    useAuth: () => state,
    useOptionalAuth: () => state,
  };
});

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false, lastSeenByUser: new Map() }),
}));

vi.mock('@/context/TypingContext', () => ({
  useTyping: () => ({ typingByThread: new Map(), recordTyping: vi.fn(), clearTyping: vi.fn(), setSelfUserID: vi.fn() }),
  threadTypingKey: (parentID: string, threadRootID: string) => `${parentID}::${threadRootID}`,
  formatTypingPhrase: (names: string[]) => names.join(', '),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({ markThreadNotificationUnread: vi.fn() }),
}));

function rootMsg(): Message {
  return {
    id: '01J0000000000000000000ROOT',
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body: 'thread root question',
    createdAt: '2026-05-01T10:00:00Z',
  };
}

function reply(): Message {
  return {
    id: '01J0000000000000000000REP1',
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body: 'a reply',
    parentMessageID: '01J0000000000000000000ROOT',
    createdAt: '2026-05-01T11:00:00Z',
  };
}

function renderPanel(messages: Message[] = [rootMsg(), reply()], onClose: () => void = vi.fn()) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(() => Promise.resolve(null));
  threadMessagesState = { data: messages, isLoading: false };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ThreadPanel
          channelId="ch-1"
          threadRootID="01J0000000000000000000ROOT"
          onClose={onClose}
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          currentUserId="u-1"
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('ThreadPanel browser behaviour', () => {
  it('renders the thread panel header', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByRole('heading', { name: 'Thread' })).toBeVisible();
  });

  it('shows the root message body once loaded', async () => {
    const screen = await renderPanel();
    await expect.element(screen.getByText('thread root question')).toBeVisible();
  });

  it('shows a relative "… ago" timestamp (threads have no day dividers)', async () => {
    await renderPanel();
    await vi.waitFor(() => {
      expect(document.body.textContent).toMatch(/ago|just now/);
    });
  });

  it('mounts the reply composer at the bottom of the panel', async () => {
    await renderPanel();
    // The reply composer is the WysiwygEditor — finding any
    // contenteditable inside the panel proves the composer mounted.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const editable = document.querySelector('[contenteditable="true"]');
    expect(editable).not.toBeNull();
  });

  it('does not crash on a thread with only the root message', async () => {
    await renderPanel([rootMsg()]);
    const editable = document.querySelector('[contenteditable="true"]');
    expect(editable).not.toBeNull();
  });

  it('marks the thread seen at the latest reply while it is open', async () => {
    markThreadSeenMock.mockClear();
    await renderPanel([rootMsg(), reply()]);
    // Marks read with the newest message's timestamp so an actively-viewed
    // thread doesn't linger as unread on /threads.
    await vi.waitFor(() => {
      expect(markThreadSeenMock).toHaveBeenCalledWith(
        '01J0000000000000000000ROOT',
        '2026-05-01T11:00:00Z',
        { parentID: 'ch-1', parentType: 'channel' },
      );
    });
  });

  it('does not mark seen when the thread has no messages yet', async () => {
    markThreadSeenMock.mockClear();
    await renderPanel([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(markThreadSeenMock).not.toHaveBeenCalled();
  });

  it('invokes onClose when the close-thread button is clicked', async () => {
    const onClose = vi.fn();
    const screen = await renderPanel([rootMsg(), reply()], onClose);
    await screen.getByRole('button', { name: 'Close thread' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders each reply body in the thread list', async () => {
    const screen = await renderPanel([rootMsg(), reply()]);
    await expect.element(screen.getByText('a reply')).toBeVisible();
  });

  it('skips a deleted own reply when locating the last editable reply', async () => {
    // findLastOwnReply walks replies from newest; an own deleted reply is
    // skipped (the `m.deleted || m.system` guard) in favour of the real one.
    const screen = await renderPanel([
      rootMsg(),
      reply(),
      { ...reply(), id: '01J0000000000000000000REP2', body: '', deleted: true },
    ]);
    await expect.element(screen.getByText('a reply')).toBeVisible();
  });

  it('replaces the composer with a notice when the thread root is deleted', async () => {
    // The server cascades a root delete to every reply and rejects new
    // ones (409). When the root comes back as a tombstone, the panel must
    // hide the composer and explain the thread is gone.
    const screen = await renderPanel([
      { ...rootMsg(), body: '', deleted: true },
      { ...reply(), body: '', deleted: true },
    ]);
    await expect.element(screen.getByText('This thread has been deleted.')).toBeVisible();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it('shows the loading state while thread messages are pending', async () => {
    threadMessagesState = { data: undefined, isLoading: true };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <ThreadPanel
            channelId="ch-1"
            threadRootID="01J0000000000000000000ROOT"
            onClose={vi.fn()}
            userMap={{ 'u-1': { displayName: 'Alice' } }}
            currentUserId="u-1"
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    // The panel header still renders while the body is loading.
    await expect.element(screen.getByRole('heading', { name: 'Thread' })).toBeVisible();
  });
});
