import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User, UserChannel, UserConversation, SidebarCategory } from '@/types';

// --- mocks ---------------------------------------------------------------

const mockUser: User = {
  id: 'u-1',
  email: 'alice@test.com',
  displayName: 'Alice Smith',
  systemRole: 'admin',
  status: 'active',
};

const mockChannels: UserChannel[] = [
  { channelID: 'ch-fav', channelName: 'fav-channel', channelType: 'public', role: 1, favorite: true },
  { channelID: 'ch-work-1', channelName: 'work-room', channelType: 'public', role: 1, categoryID: 'cat-work' },
  { channelID: 'ch-work-2', channelName: 'roadmap', channelType: 'private', role: 1, categoryID: 'cat-work' },
  { channelID: 'ch-other', channelName: 'random', channelType: 'public', role: 1 },
];

const mockCategories: SidebarCategory[] = [
  { id: 'cat-work', name: 'Work', position: 0 },
  { id: 'cat-empty', name: 'Reading List', position: 1 },
];

const mockConversations: UserConversation[] = [];

const createCategoryMutate = vi.fn();

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

vi.mock('@/hooks/useThreads', () => ({
  useUserThreads: () => ({ data: [] }),
  hasUnreadActivity: () => false,
}));

vi.mock('@/hooks/useSidebar', () => ({
  useCategories: () => ({ data: mockCategories }),
  useCreateCategory: () => ({ mutate: createCategoryMutate }),
  useFavoriteChannel: () => ({ mutate: vi.fn() }),
  useSetCategory: () => ({ mutate: vi.fn() }),
  useFavoriteConversation: () => ({ mutate: vi.fn() }),
  useSetConversationCategory: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({
  getAccessToken: () => 'mock-token',
  setAccessToken: vi.fn(),
  apiFetch: vi.fn(),
}));

// Render dropdown menu items inline so kebab menus inside ChannelRow are reachable.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button data-testid="dropdown-item" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { Sidebar } from '@/components/layout/Sidebar';

// --- helpers -------------------------------------------------------------

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Sidebar onClose={vi.fn()} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

// --- tests ---------------------------------------------------------------

describe('Sidebar grouped rendering', () => {
  beforeEach(() => {
    createCategoryMutate.mockReset();
  });

  it('renders Favorites group with the favorited channel', () => {
    renderSidebar();
    const favGroup = screen.getByTestId('sidebar-group-__favorites__');
    expect(within(favGroup).getByText('Favorites')).toBeInTheDocument();
    expect(within(favGroup).getByText('fav-channel')).toBeInTheDocument();
    // Non-favorite channels must not appear in the Favorites section.
    expect(within(favGroup).queryByText('work-room')).not.toBeInTheDocument();
    expect(within(favGroup).queryByText('random')).not.toBeInTheDocument();
  });

  it('renders a section for each user category with its channels', () => {
    renderSidebar();
    const work = screen.getByTestId('sidebar-group-cat-work');
    expect(within(work).getByText('Work')).toBeInTheDocument();
    expect(within(work).getByText('work-room')).toBeInTheDocument();
    expect(within(work).getByText('roadmap')).toBeInTheDocument();
    expect(within(work).queryByText('random')).not.toBeInTheDocument();
  });

  it('renders empty user-defined categories so users can drop channels in', () => {
    renderSidebar();
    const empty = screen.getByTestId('sidebar-group-cat-empty');
    expect(within(empty).getByText('Reading List')).toBeInTheDocument();
  });

  it('renders default Channels group with uncategorised channels', () => {
    renderSidebar();
    // Default uncategorised channels now sit under the "Channels"
    // section (renamed from "Other" when the layout merged channels +
    // DMs into a single grouped list).
    const channels = screen.getByTestId('sidebar-group-__channels__');
    expect(within(channels).getByText('Channels')).toBeInTheDocument();
    expect(within(channels).getByText('random')).toBeInTheDocument();
    // Categorised and favorited channels do NOT belong here.
    expect(within(channels).queryByText('work-room')).not.toBeInTheDocument();
    expect(within(channels).queryByText('fav-channel')).not.toBeInTheDocument();
  });

  it('collapses and expands a group when its header toggle is clicked', () => {
    renderSidebar();
    const work = screen.getByTestId('sidebar-group-cat-work');
    expect(within(work).getByText('work-room')).toBeInTheDocument();

    const toggle = screen.getByTestId('sidebar-group-toggle-cat-work');
    fireEvent.click(toggle);
    expect(within(work).queryByText('work-room')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(within(work).getByText('work-room')).toBeInTheDocument();
  });

  it('reveals an inline create input when "+ category" header button is clicked', () => {
    renderSidebar();
    expect(screen.queryByTestId('sidebar-new-category-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('new-category-button'));
    expect(screen.getByTestId('sidebar-new-category-input')).toBeInTheDocument();
  });

  it('Enter on the inline input creates the category', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('new-category-button'));
    const input = screen.getByTestId('sidebar-new-category-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Side projects' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createCategoryMutate).toHaveBeenCalledTimes(1);
    expect(createCategoryMutate.mock.calls[0][0]).toBe('Side projects');
  });

  it('Enter with whitespace-only input is a no-op', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('new-category-button'));
    const input = screen.getByTestId('sidebar-new-category-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createCategoryMutate).not.toHaveBeenCalled();
  });

  it('Escape on the inline input cancels and hides it', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('new-category-button'));
    const input = screen.getByTestId('sidebar-new-category-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('sidebar-new-category-input')).not.toBeInTheDocument();
    expect(createCategoryMutate).not.toHaveBeenCalled();
  });

  it('inline input clears and hides on successful create', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('new-category-button'));
    const input = screen.getByTestId('sidebar-new-category-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Side projects' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Pull onSuccess off the mutate options and invoke it to mimic the
    // server returning the created category.
    const opts = createCategoryMutate.mock.calls[0][1] as {
      onSuccess: (cat: SidebarCategory) => void;
    };
    act(() => {
      opts.onSuccess({ id: 'cat-new', name: 'Side projects', position: 99 });
    });
    expect(screen.queryByTestId('sidebar-new-category-input')).not.toBeInTheDocument();
  });
});
