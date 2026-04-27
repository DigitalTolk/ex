import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
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
const deleteCategoryMutate = vi.fn();

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
  useDeleteCategory: () => ({ mutate: deleteCategoryMutate }),
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
    'data-testid': testid,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button data-testid={testid ?? 'dropdown-item'} onClick={onClick} disabled={disabled}>
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

function renderSidebarAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// --- tests ---------------------------------------------------------------

describe('Sidebar grouped rendering', () => {
  beforeEach(() => {
    createCategoryMutate.mockReset();
    deleteCategoryMutate.mockReset();
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

    fireEvent.click(screen.getByTestId('sidebar-add-category'));
    expect(screen.getByTestId('sidebar-new-category-input')).toBeInTheDocument();
  });

  it('Enter on the inline input creates the category', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-add-category'));
    const input = screen.getByTestId('sidebar-new-category-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Side projects' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createCategoryMutate).toHaveBeenCalledTimes(1);
    expect(createCategoryMutate.mock.calls[0][0]).toBe('Side projects');
  });

  it('Enter with whitespace-only input is a no-op', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-add-category'));
    const input = screen.getByTestId('sidebar-new-category-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createCategoryMutate).not.toHaveBeenCalled();
  });

  it('Escape on the inline input cancels and hides it', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-add-category'));
    const input = screen.getByTestId('sidebar-new-category-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('sidebar-new-category-input')).not.toBeInTheDocument();
    expect(createCategoryMutate).not.toHaveBeenCalled();
  });

  it('inline input clears and hides on successful create', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-add-category'));
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

  it('does not render an item-count next to section titles', () => {
    // The header counter ("3" beside "Channels") was visual noise — the
    // group is collapsible, so users see the actual rows. The toggle
    // button must not contain any text outside the section title.
    renderSidebar();
    const work = screen.getByTestId('sidebar-group-cat-work');
    const toggle = within(work).getByTestId('sidebar-group-toggle-cat-work');
    // Two channels live in this section; the count "2" must not appear.
    expect(toggle.textContent).toBe('Work');
  });

  it('renders the divider between top-level pages and the channel list', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar-top-divider')).toBeInTheDocument();
  });

  it('Directory + Threads links use the same vertical padding as channel rows', () => {
    // Channel rows use px-2 py-1; Directory and Threads must match so
    // the eye doesn't catch on a height bump between the top-level
    // links and the channel list. Margin-bottom (mb-*) is the
    // separator's job now, not per-row spacing.
    renderSidebar();
    const directory = screen.getByText('Directory').closest('a');
    const threads = screen.getByText('Threads').closest('a');
    expect(directory?.className).toMatch(/\bpy-1\b/);
    expect(directory?.className).not.toMatch(/\bpy-1\.5\b/);
    expect(directory?.className).not.toMatch(/\bmb-2\b/);
    expect(threads?.className).toMatch(/\bpy-1\b/);
    expect(threads?.className).not.toMatch(/\bpy-1\.5\b/);
    expect(threads?.className).not.toMatch(/\bmb-2\b/);
  });

  it('keeps the currently-viewed channel visible even when its category is collapsed', () => {
    // Bug: collapsing a category hid the channel the user was actively
    // looking at, so a click on the chevron made the row vanish out from
    // under them. The active row must stay visible while the user is on
    // it; once they navigate elsewhere it hides again.
    const { unmount } = renderSidebarAt('/channel/work-room');
    const work = screen.getByTestId('sidebar-group-cat-work');
    // Collapse the section.
    fireEvent.click(within(work).getByTestId('sidebar-group-toggle-cat-work'));
    expect(within(work).getByText('work-room')).toBeInTheDocument();
    // The other channel in the same category is hidden — only the active
    // one survives the fold.
    expect(within(work).queryByText('roadmap')).not.toBeInTheDocument();
    unmount();
  });

  it('hides the channel again once the user navigates away (collapsed section)', () => {
    // Same fixture, different URL — the active-survival rule must NOT
    // pin a row globally; it follows the location.
    renderSidebarAt('/channel/somewhere-else');
    const work = screen.getByTestId('sidebar-group-cat-work');
    fireEvent.click(within(work).getByTestId('sidebar-group-toggle-cat-work'));
    expect(within(work).queryByText('work-room')).not.toBeInTheDocument();
    expect(within(work).queryByText('roadmap')).not.toBeInTheDocument();
  });

  it('places the "Add category" affordance ABOVE the channel sections', () => {
    // Order matters — users discover the action before scrolling. The
    // Add-category button must appear in the DOM before the first
    // section header.
    renderSidebar();
    const add = screen.getByTestId('sidebar-add-category');
    const firstSection = screen.getAllByTestId(/^sidebar-group-/)[0];
    expect(
      add.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('opens a modal (not window.confirm) when Delete category is clicked', () => {
    // Spy in case the dialog wasn't wired and the code falls back to
    // window.confirm — that would be the regression we want to catch.
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-category-delete-cat-work'));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-category')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('Cancel in the delete-category dialog closes without firing the mutation', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-category-delete-cat-work'));
    fireEvent.click(screen.getByTestId('delete-category-cancel'));
    expect(deleteCategoryMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('delete-category')).toBeNull();
  });

  it('Confirm in the delete-category dialog fires the mutation with the category id', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-category-delete-cat-work'));
    fireEvent.click(screen.getByTestId('delete-category-confirm'));
    expect(deleteCategoryMutate).toHaveBeenCalledWith('cat-work');
    expect(screen.queryByTestId('delete-category')).toBeNull();
  });
});
