import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '@/components/layout/Sidebar';
import type { User, UserChannel, UserConversation } from '@/types';

// --- mocks ---------------------------------------------------------------

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

const mockLogout = vi.fn().mockResolvedValue(undefined);
const mockSetAuth = vi.fn();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: mockLogout,
    setAuth: mockSetAuth,
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

// Mock the dropdown menu to work in jsdom
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props} data-testid="user-menu-trigger">{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button data-testid="dropdown-item" onClick={onClick}>{children}</button>
  ),
}));

// --- helpers -------------------------------------------------------------

function renderSidebar(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Sidebar onClose={onClose} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

// --- tests ---------------------------------------------------------------

describe('Sidebar - user menu actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Invite people option for admin users', () => {
    renderSidebar();
    const items = screen.getAllByTestId('dropdown-item');
    const inviteItem = items.find(item => item.textContent?.includes('Invite people'));
    expect(inviteItem).toBeTruthy();
  });

  it('shows Edit profile option', () => {
    renderSidebar();
    const items = screen.getAllByTestId('dropdown-item');
    const editItem = items.find(item => item.textContent?.includes('Edit profile'));
    expect(editItem).toBeTruthy();
  });

  it('shows Sign out option', () => {
    renderSidebar();
    const items = screen.getAllByTestId('dropdown-item');
    const signOutItem = items.find(item => item.textContent?.includes('Sign out'));
    expect(signOutItem).toBeTruthy();
  });

  it('calls logout when Sign out is clicked', async () => {
    const user = userEvent.setup();
    renderSidebar();

    const items = screen.getAllByTestId('dropdown-item');
    const signOutItem = items.find(item => item.textContent?.includes('Sign out'));
    await user.click(signOutItem!);

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

});
