import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Channel, ChannelMembership } from '@/types';

// Mock dropdown to a simple structure so we can click items in jsdom
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => (
    <button data-testid="dropdown-item" onClick={onClick} className={className}>{children}</button>
  ),
}));

// Mock dialog so the archive confirm always shows
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockChannel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  description: 'Old description',
};

let mockMembers: ChannelMembership[] = [
  { channelID: 'ch-1', userID: 'u-1', role: 'owner', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
];

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

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: () => ({ data: mockChannel }),
  useChannelMembers: () => ({ data: mockMembers }),
  useUserChannels: () => ({ data: [] }),
  useBrowseChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useMuteChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

const mockSendMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useChannelMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendChannelMessage: () => ({ mutate: mockSendMutate, isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Import after mocks
import { ChannelView } from './ChannelView';

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

// Default mock implementation: return populated users for batch, {} for everything else
function setDefaultApi() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url === '/api/v1/users/batch') {
      return Promise.resolve([
        { id: 'u-1', displayName: 'Alice', avatarURL: 'http://x/a.png' },
        { id: 'u-2', displayName: '', avatarURL: undefined }, // exercises 'Unknown' fallback (line 76)
      ]);
    }
    return Promise.resolve({});
  });
}

describe('ChannelView - actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembers = [
      { channelID: 'ch-1', userID: 'u-1', role: 'owner', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
    ];
    setDefaultApi();
  });

  it('renders nothing when slug missing', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/channel/']}>
          <Routes>
            <Route path="/channel/" element={<ChannelView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/select a channel to start chatting/i)).toBeInTheDocument();
  });

  it('handleSend forwards body to send mutation', async () => {
    const user = userEvent.setup();
    renderChannelView();

    const input = screen.getByPlaceholderText('Message #general');
    await user.type(input, 'hello world{enter}');

    expect(mockSendMutate).toHaveBeenCalledWith({ body: 'hello world', attachmentIDs: [] });
  });

  it('owner can archive channel — archives via apiFetch DELETE and navigates', async () => {
    renderChannelView();

    // Click "Archive channel" item directly
    const items = await screen.findAllByTestId('dropdown-item');
    const archiveItem = items.find((b) => b.textContent?.includes('Archive channel'));
    expect(archiveItem).toBeDefined();
    fireEvent.click(archiveItem!);

    // Confirm in dialog
    fireEvent.click(screen.getByText('Archive'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('member can leave non-general channel — POSTs to /leave and navigates', async () => {
    // Use a non-general slug so the #general lockdown doesn't apply.
    mockChannel.slug = 'random';
    mockChannel.name = 'random';
    mockMembers = [
      { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
    ];
    renderChannelView('random');

    const items = await screen.findAllByTestId('dropdown-item');
    const leaveItem = items.find((b) => b.textContent?.includes('Leave channel'));
    expect(leaveItem).toBeDefined();
    fireEvent.click(leaveItem!);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/leave',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
    // Restore for subsequent tests in this file.
    mockChannel.slug = 'general';
    mockChannel.name = 'general';
  });

  it('member cannot leave the #general channel', async () => {
    mockChannel.slug = 'general';
    mockChannel.name = 'general';
    mockMembers = [
      { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
    ];
    renderChannelView();

    // Either the actions dropdown is empty (no leave to show) and not
    // rendered, or it exists with no Leave channel item — both are valid.
    const items = screen.queryAllByTestId('dropdown-item');
    const leaveItem = items.find((b) => b.textContent?.includes('Leave channel'));
    expect(leaveItem).toBeUndefined();
  });

  it('handleDescriptionSave PATCHes the channel', async () => {
    renderChannelView();

    // Click the description text (canEdit because role=owner)
    fireEvent.click(screen.getByTitle('Click to edit description'));
    const input = screen.getByPlaceholderText('Add a description...');
    fireEvent.change(input, { target: { value: 'New desc' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ description: 'New desc' }),
        }),
      );
    });
  });
});
