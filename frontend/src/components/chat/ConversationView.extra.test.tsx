import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Conversation } from '@/types';

let mockConversation: Conversation = {
  id: 'conv-2',
  type: 'group',
  name: '',
  participantIDs: ['u-1', 'u-2', 'u-3'],
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

const mockSendMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useConversationMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendConversationMessage: () => ({ mutate: mockSendMutate, isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([
    { id: 'u-2', displayName: 'Bob' },
    { id: 'u-3', displayName: 'Charlie' },
  ]),
}));

import { ConversationView } from './ConversationView';

function renderConversationView(id = 'conv-2') {
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

describe('ConversationView - extra coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders fallback when no id in route', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/conversation/']}>
          <Routes>
            <Route path="/conversation/" element={<ConversationView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/select a conversation/i)).toBeInTheDocument();
  });

  it('forwards body to send mutation when message is sent', async () => {
    const user = userEvent.setup();
    renderConversationView();

    // Group title with no name → use participants — wait for it
    const inputs = await screen.findAllByPlaceholderText(/Message/);
    await user.type(inputs[0], 'hi all{enter}');
    expect(mockSendMutate).toHaveBeenCalledWith({ body: 'hi all', attachmentIDs: [] });
  });

  it('renders group conversation with member toggle', async () => {
    renderConversationView();
    expect(await screen.findByLabelText('Toggle member list')).toBeInTheDocument();
  });

  it('uses conversation.name when participants are not yet resolved for group', async () => {
    mockConversation = {
      id: 'conv-3',
      type: 'group',
      name: 'My Group',
      participantIDs: ['u-1'],
      createdAt: '2026-01-01T00:00:00Z',
    };
    renderConversationView('conv-3');
    expect(await screen.findByText('My Group')).toBeInTheDocument();
  });
});
