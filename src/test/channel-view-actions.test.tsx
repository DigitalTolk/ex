import { describe, it, expect, vi, beforeEach } from 'vitest';

// MarkdownComposer pulls in roster/channel/emoji/auth/presence data hooks these
// view-level tests don't stub; they don't exercise the composer, so stub it with
// a plain textarea (matches the message-input-validation stub).
vi.mock('@/components/chat/markdown/MarkdownComposer', () => ({
  MarkdownComposer: (props: {
    ariaLabel?: string;
    placeholder?: string;
    onChange?: (md: string) => void;
    onSubmit?: (md: string) => void;
  }) => (
    <div>
      <textarea
        aria-label={props.ariaLabel ?? 'Message input'}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit?.((e.target as HTMLTextAreaElement).value);
          }
        }}
        data-testid="composer-stub"
      />
      {props.placeholder ? <span>{props.placeholder}</span> : null}
    </div>
  ),
}));
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from '@/components/chat/ChannelView';
import type { Channel, ChannelMembership } from '@/types';

// --- mocks ---------------------------------------------------------------

const mockChannel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  description: 'General chat',
};

const mockMembersOwner: ChannelMembership[] = [
  { channelID: 'ch-1', userID: 'u-1', role: 3 as unknown as ChannelMembership['role'], displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
  { channelID: 'ch-1', userID: 'u-2', role: 'member', displayName: 'Bob', joinedAt: '2026-01-01T00:00:00Z' },
];

const mockMembersMember: ChannelMembership[] = [
  { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
  { channelID: 'ch-1', userID: 'u-2', role: 'owner', displayName: 'Bob', joinedAt: '2026-01-01T00:00:00Z' },
];

let currentMembers = mockMembersOwner;

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

// ONE stable object: ChannelView's mount effect lists setActiveChannel /
// setActiveParent in its deps, so a mock that mints fresh vi.fn()s per render
// re-runs the effect on every re-render — which re-PUTs /read and makes any
// call-count assertion about the read marker meaningless.
const unreadValue = {
  unreadChannels: new Set(),
  unreadChannelNotifications: new Set(),
  unreadConversations: new Set(),
  hiddenConversations: new Set(),
  markChannelUnread: vi.fn(),
  markChannelNotificationUnread: vi.fn(),
  markConversationUnread: vi.fn(),
  clearChannelUnread: vi.fn(),
  clearConversationUnread: vi.fn(),
  hideConversation: vi.fn(),
  unhideConversation: vi.fn(),
  setActiveChannel: vi.fn(),
  setActiveConversation: vi.fn(),
  isActiveChannel: vi.fn(() => false),
  isActiveConversation: vi.fn(() => false),
  setActiveThread: vi.fn(),
  isActiveThread: vi.fn(() => false),
};
vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => unreadValue,
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline: vi.fn(),
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: () => ({ data: mockChannel }),
  useChannelMembers: () => ({ data: currentMembers }),
  useUserChannels: () => ({ data: [] }),
  useBrowseChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useMuteChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useMessages', () => ({
  useChannelMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendChannelMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

const mockApiFetch = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// --- helpers -------------------------------------------------------------

function renderChannelView(slug = 'general') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/channel/${slug}`]}>
        <Routes>
          <Route path="/channel/:id" element={<ChannelView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// --- tests ---------------------------------------------------------------

describe('ChannelView - owner actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMembers = mockMembersOwner;
  });

  it('shows member list when toggle is clicked', async () => {
    renderChannelView();
    fireEvent.click(screen.getByLabelText('Toggle member list'));
    expect(screen.getByText('Members')).toBeInTheDocument();
  });

  it('builds memberMap from channel members', () => {
    renderChannelView();
    // The channel renders, which means memberMap was constructed successfully
    expect(screen.getByRole('heading', { name: 'general' })).toBeInTheDocument();
  });
});

describe('ChannelView - member actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMembers = mockMembersMember;
  });

  it('renders channel for a regular member', () => {
    renderChannelView();
    expect(screen.getByRole('heading', { name: 'general' })).toBeInTheDocument();
  });

  // The other half of the attention-gated read model: messages that arrive
  // while the window is blurred keep the unread badge (ChatPage bumps it);
  // the read is persisted when the user comes BACK to the window. Without
  // this, an unwatched-but-open channel accumulated unread that nothing ever
  // cleared until a route change.
  it('marks the channel read again when the window regains focus', async () => {
    renderChannelView();
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
    });
    mockApiFetch.mockClear();
    // jsdom's hasFocus() is false; a real focus event implies focus.
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      fireEvent.focus(window);
      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
      });
    } finally {
      hasFocusSpy.mockRestore();
    }
  });

  it('does NOT re-read on a visibility flip while the window stays unfocused', async () => {
    renderChannelView();
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
    });
    mockApiFetch.mockClear();
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      fireEvent(document, new Event('visibilitychange'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
    } finally {
      hasFocusSpy.mockRestore();
    }
  });
});

describe('ChannelView - no slug', () => {
  it('shows placeholder when no slug is provided', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/channel/']}>
          <Routes>
            <Route path="/channel/" element={<ChannelView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // ChannelView without slug shows placeholder
    expect(screen.getByText('Select a channel to start chatting')).toBeInTheDocument();
  });
});
