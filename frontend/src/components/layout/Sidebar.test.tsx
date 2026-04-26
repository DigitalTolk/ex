import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
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
  { channelID: 'ch-2', channelName: 'secret', channelType: 'private', role: 1 },
  { channelID: 'ch-3', channelName: 'My Cool Channel!', channelType: 'public', role: 1 },
];

const mockConversations: UserConversation[] = [
  { conversationID: 'conv-1', type: 'dm', displayName: 'Bob Jones' },
  { conversationID: 'conv-2', type: 'group', displayName: 'Project Team' },
];

const mockLogout = vi.fn().mockResolvedValue(undefined);
const mockLogin = vi.fn();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    login: mockLogin,
    logout: mockLogout,
    setAuth: vi.fn(),
  }),
}));

const mockUnreadChannels = new Set<string>();
const mockUnreadConversations = new Set<string>();

let mockHiddenConversations = new Set<string>();
const mockHideConversation = vi.fn((id: string) => {
  mockHiddenConversations = new Set(mockHiddenConversations).add(id);
});

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: mockUnreadChannels,
    unreadConversations: mockUnreadConversations,
    hiddenConversations: mockHiddenConversations,
    markChannelUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    hideConversation: mockHideConversation,
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

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnreadChannels.clear();
    mockUnreadConversations.clear();
    mockHiddenConversations.clear();
    localStorage.clear();
  });

  it('renders user display name', () => {
    renderSidebar();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it('renders user initials in avatar fallback', () => {
    renderSidebar();
    expect(screen.getByText('AS')).toBeInTheDocument();
  });

  it('shows Admin badge for admin users', () => {
    renderSidebar();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('renders channel list', () => {
    renderSidebar();
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('renders Channels heading', () => {
    renderSidebar();
    expect(screen.getByText('Channels')).toBeInTheDocument();
  });

  it('renders Direct Messages heading', () => {
    renderSidebar();
    expect(screen.getByText('Direct Messages')).toBeInTheDocument();
  });

  it('renders conversation list', () => {
    renderSidebar();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('Project Team')).toBeInTheDocument();
  });

  it('renders Directory link', () => {
    renderSidebar();
    expect(screen.getByText('Directory')).toBeInTheDocument();
  });

  it('renders Create channel button', () => {
    renderSidebar();
    expect(screen.getByLabelText('Create channel')).toBeInTheDocument();
  });

  it('renders New direct message button', () => {
    renderSidebar();
    expect(screen.getByLabelText('New direct message')).toBeInTheDocument();
  });

  it('shows unread indicator for channels', () => {
    mockUnreadChannels.add('ch-1');
    renderSidebar();
    const nav = screen.getByLabelText('Channels');
    const dots = nav.querySelectorAll('span.ml-auto');
    expect(dots.length).toBeGreaterThanOrEqual(1);
  });

  it('shows unread indicator for conversations', () => {
    mockUnreadConversations.add('conv-1');
    renderSidebar();
    const nav = screen.getByLabelText('Direct messages');
    const dots = nav.querySelectorAll('span.ml-auto');
    expect(dots.length).toBeGreaterThanOrEqual(1);
  });

  it('calls hideConversation when close button is clicked', async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(screen.getByText('Bob Jones')).toBeInTheDocument();

    const closeButtons = screen.getAllByLabelText('Close conversation');
    await user.click(closeButtons[0]);

    expect(mockHideConversation).toHaveBeenCalledWith('conv-1');
  });

  it('filters out hidden conversations from view', () => {
    mockHiddenConversations.add('conv-1');
    renderSidebar();

    expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument();
    expect(screen.getByText('Project Team')).toBeInTheDocument();
  });

  it('has user menu trigger', () => {
    renderSidebar();
    expect(screen.getByLabelText('User menu')).toBeInTheDocument();
  });

  it('uses slugified channel name in NavLink href', () => {
    renderSidebar();
    const nav = screen.getByLabelText('Channels');
    const links = nav.querySelectorAll('a');
    const hrefs = Array.from(links).map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/channel/general');
    expect(hrefs).toContain('/channel/secret');
    // "My Cool Channel!" should slugify to "my-cool-channel"
    expect(hrefs).toContain('/channel/my-cool-channel');
  });
});
