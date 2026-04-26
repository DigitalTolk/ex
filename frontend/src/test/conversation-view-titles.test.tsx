import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationView } from '@/components/chat/ConversationView';
import type { Conversation } from '@/types';

// --- mocks ---------------------------------------------------------------

let mockConversation: Conversation = {
  id: 'conv-1',
  type: 'dm',
  participantIDs: ['u-1', 'u-2'],
  createdAt: '2026-01-01T00:00:00Z',
};

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

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set(),
    unreadConversations: new Set(),
    hiddenConversations: new Set(),
    markChannelUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    hideConversation: vi.fn(),
    unhideConversation: vi.fn(),
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation: vi.fn(() => false),
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline: vi.fn(),
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useConversations', () => ({
  useConversation: () => ({ data: mockConversation }),
  useUserConversations: () => ({ data: [] }),
  useSearchUsers: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useMessages', () => ({
  useConversationMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendConversationMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([
    { id: 'u-2', displayName: 'Bob' },
  ]),
}));

// --- helpers -------------------------------------------------------------

function renderConversationView(id = 'conv-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/conversation/${id}`]}>
        <Routes>
          <Route path="/conversation/:id" element={<ConversationView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// --- tests ---------------------------------------------------------------

describe('ConversationView - DM title', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversation = {
      id: 'conv-1',
      type: 'dm',
      participantIDs: ['u-1', 'u-2'],
      createdAt: '2026-01-01T00:00:00Z',
    };
  });

  it('shows other participant name as title for DM', async () => {
    renderConversationView();
    await waitFor(() => {
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  it('shows "Direct Message" when no participant names resolved', () => {
    renderConversationView();
    // Before names resolve, should show fallback
    expect(screen.getByText('Direct Message')).toBeInTheDocument();
  });
});

describe('ConversationView - Group title', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { apiFetch } = await import('@/lib/api');
    vi.mocked(apiFetch).mockResolvedValue([
      { id: 'u-2', displayName: 'Bob' },
      { id: 'u-3', displayName: 'Charlie' },
    ]);
    mockConversation = {
      id: 'conv-1',
      type: 'group',
      participantIDs: ['u-1', 'u-2', 'u-3'],
      createdAt: '2026-01-01T00:00:00Z',
    };
  });

  it('derives group title from participant names when no name set', async () => {
    renderConversationView();
    await waitFor(() => {
      expect(screen.getByText('Bob, Charlie')).toBeInTheDocument();
    });
  });

  it('does not render subtitle for group conversations (names are the title)', async () => {
    renderConversationView();
    await waitFor(() => {
      expect(screen.getByText('Bob, Charlie')).toBeInTheDocument();
    });
    // The full participant list (with self) should NOT render as a subtitle
    expect(screen.queryByText('Alice, Bob, Charlie')).not.toBeInTheDocument();
  });

  it('shows member count badge for group conversations', async () => {
    renderConversationView();
    // memberCount is participantIDs.length = 3
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('shows toggle member list button for group', async () => {
    renderConversationView();
    await waitFor(() => {
      expect(screen.getByLabelText('Toggle member list')).toBeInTheDocument();
    });
  });

  it('toggles member list when clicking member count for group', async () => {
    const user = userEvent.setup();
    renderConversationView();

    await waitFor(() => {
      expect(screen.getByLabelText('Toggle member list')).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText('Toggle member list'));

    // After toggling, member names should appear in the member sidebar
    await waitFor(() => {
      expect(screen.getByText('Members')).toBeInTheDocument();
    });
  });

  it('uses conversation.name for group title when set', async () => {
    mockConversation = {
      ...mockConversation,
      name: 'My Group',
    };
    renderConversationView();
    // The conversation has a name, so it should be used as the title
    expect(screen.getByText('My Group')).toBeInTheDocument();
  });
});
