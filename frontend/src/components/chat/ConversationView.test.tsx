import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('renders message input with conversation placeholder', async () => {
    renderConversationView();
    await waitFor(() => {
      expect(screen.getByText('Write to Chat with Bob')).toBeInTheDocument();
    });
  });

  it('shows "No messages yet" when there are no messages', () => {
    renderConversationView();
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it('does not render member toggle for DM conversations', () => {
    renderConversationView();
    expect(screen.queryByLabelText('Toggle member list')).not.toBeInTheDocument();
  });

  it('keeps MessageList as a direct child of MessageDropZone (no nested wrapper) — broke DM scrolling when wrapped', () => {
    // Regression: an earlier attempt to fix typing-indicator
    // positioning wrapped MessageList inside an extra
    // `relative flex-1 flex-col min-h-0` container. That nested flex
    // layer broke the height-propagation chain so MessageList stopped
    // scrolling in DMs and drifted on send in channels. The typing
    // indicator now uses normal-flow positioning instead.
    const { container } = renderConversationView();
    const dropzone = container.querySelector('div.flex.flex-1.flex-col.min-h-0');
    expect(dropzone).not.toBeNull();
    const messages = container.querySelector('div.overflow-y-auto') as HTMLElement;
    expect(messages.parentElement).toBe(dropzone);

    // DOM order: messages → input. Anything between (e.g., the typing
    // indicator when it's visible) renders here in normal flow.
    const children = Array.from(dropzone!.children);
    const inputIdx = children.findIndex((c) =>
      c.querySelector('[aria-label="Message input"]'),
    );
    const messagesIdx = children.indexOf(messages);
    expect(messagesIdx).toBeGreaterThanOrEqual(0);
    expect(inputIdx).toBeGreaterThan(messagesIdx);
  });
});
