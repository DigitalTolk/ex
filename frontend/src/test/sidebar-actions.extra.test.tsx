import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User, UserChannel, UserConversation } from '@/types';

const mockUser: User = {
  id: 'u-1',
  email: 'alice@test.com',
  displayName: 'Alice Smith',
  systemRole: 'admin',
  status: 'active',
};

const mockChannels: UserChannel[] = [
  { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
];

const mockConversations: UserConversation[] = [
  { conversationID: 'conv-1', type: 'dm', displayName: 'Bob Jones' },
];

const mockHide = vi.fn();
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
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
    hideConversation: mockHide,
    unhideConversation: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: mockChannels }),
  useChannelBySlug: () => ({ data: undefined }),
  useChannelMembers: () => ({ data: [] }),
  useBrowseChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: mockConversations }),
  useSearchUsers: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/api', () => ({
  getAccessToken: () => 'mock-token',
  setAccessToken: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button data-testid="dropdown-item" onClick={onClick}>{children}</button>
  ),
}));

import { Sidebar } from '@/components/layout/Sidebar';
import { ThemeProvider } from '@/context/ThemeContext';

function renderSidebar(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <Sidebar onClose={onClose} />
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('Sidebar - extra actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens InviteDialog when admin clicks Invite people', () => {
    renderSidebar();
    const items = screen.getAllByTestId('dropdown-item');
    const inviteItem = items.find((b) => b.textContent?.includes('Invite people'));
    fireEvent.click(inviteItem!);

    // Invite dialog title visible
    expect(screen.getByText('Invite someone')).toBeInTheDocument();
  });

  it('opens EditProfileDialog when Edit profile is clicked', () => {
    renderSidebar();
    const items = screen.getAllByTestId('dropdown-item');
    const editItem = items.find((b) => b.textContent?.includes('Edit profile'));
    fireEvent.click(editItem!);

    // Dialog rendered: look for an input (e.g., Display name) which only exists inside the dialog body.
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
  });

  it('opens CreateChannelDialog when Create channel button is clicked', () => {
    renderSidebar();
    fireEvent.click(screen.getByLabelText('Create channel'));

    expect(screen.getByText('Create a channel')).toBeInTheDocument();
  });

  it('navigates to /conversations/new when New direct message button is clicked', () => {
    renderSidebar();
    fireEvent.click(screen.getByLabelText('New direct message'));
    expect(window.location.pathname).toBe('/conversations/new');
  });

  it('hides a conversation when its X button is clicked', () => {
    renderSidebar();
    fireEvent.click(screen.getByLabelText('Close conversation'));
    expect(mockHide).toHaveBeenCalledWith('conv-1');
  });
});
