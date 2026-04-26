import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationView } from './ConversationView';
import type { Conversation } from '@/types';

// --- mocks ---------------------------------------------------------------

const mockConversation: Conversation = {
  id: 'conv-1',
  type: 'dm',
  name: 'Chat with Bob',
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
    markChannelUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
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
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ id: 'u-2', displayName: 'Bob' }),
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

describe('ConversationView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders conversation title from name', () => {
    renderConversationView();
    expect(screen.getByText('Chat with Bob')).toBeInTheDocument();
  });

  it('renders message input with conversation placeholder', () => {
    renderConversationView();
    expect(screen.getByPlaceholderText('Message Chat with Bob')).toBeInTheDocument();
  });

  it('shows "No messages yet" when there are no messages', () => {
    renderConversationView();
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it('does not render member toggle for DM conversations', () => {
    renderConversationView();
    expect(screen.queryByLabelText('Toggle member list')).not.toBeInTheDocument();
  });
});
