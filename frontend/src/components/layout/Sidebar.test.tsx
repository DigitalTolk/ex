import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import type { User, UserChannel, UserConversation } from '@/types';

// --- mocks ---------------------------------------------------------------

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  apiFetch: mockApiFetch,
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => {
  type DragLocation = { current: { input: { clientX: number; clientY: number }; dropTargets: Array<{ data: Record<string | symbol, unknown> }> } };
  type Monitor = {
    onDragStart?: (args: { source: { data: Record<string, unknown> }; location: DragLocation }) => void;
    onDropTargetChange?: (args: { location: DragLocation }) => void;
    onDrag?: (args: { location: DragLocation }) => void;
    onDrop?: (args: { location: DragLocation }) => void;
  };
  const monitors = new Set<Monitor>();
  let activeSource: { data: Record<string, unknown> } | null = null;
  let activeDropTargets: Array<{ data: Record<string | symbol, unknown> }> = [];
  let activeInput = { clientX: 0, clientY: 0 };

  function location() {
    return { current: { input: activeInput, dropTargets: activeDropTargets } };
  }

  return {
    draggable: ({
      dragHandle,
      element,
      getInitialData,
      onDragStart,
      onDrop,
    }: {
      dragHandle?: Element | null;
      element: HTMLElement;
      getInitialData?: () => Record<string, unknown>;
      onDragStart?: () => void;
      onDrop?: () => void;
    }) => {
      const handle = (dragHandle ?? element) as HTMLElement;
      handle.ondragstart = (event) => {
        activeInput = { clientX: event.clientX, clientY: event.clientY };
        activeSource = { data: getInitialData?.() ?? {} };
        onDragStart?.();
        for (const monitor of monitors) monitor.onDragStart?.({ source: activeSource, location: location() });
      };
      handle.ondragend = () => {
        onDrop?.();
        for (const monitor of monitors) monitor.onDrop?.({ location: location() });
        activeSource = null;
        activeDropTargets = [];
      };
      return () => {
        handle.ondragstart = null;
        handle.ondragend = null;
      };
    },
    dropTargetForElements: ({
      element,
      getData,
    }: {
      element: Element;
      getData?: (args: { input: { clientX: number; clientY: number }; element: Element }) => Record<string | symbol, unknown>;
    }) => {
      const target = element as HTMLElement;
      const readData = (event: DragEvent) =>
        getData?.({
          input: {
            clientX: event.clientX,
            clientY: event.clientY,
          },
          element,
        }) ?? {};
      target.ondragover = (event) => {
        event.preventDefault();
        event.stopPropagation();
        activeInput = { clientX: event.clientX, clientY: event.clientY };
        activeDropTargets = [{ data: readData(event) }];
        for (const monitor of monitors) {
          monitor.onDropTargetChange?.({ location: location() });
          monitor.onDrag?.({ location: location() });
        }
      };
      target.ondrop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        activeInput = { clientX: event.clientX, clientY: event.clientY };
        activeDropTargets = [{ data: readData(event) }];
        for (const monitor of monitors) monitor.onDrop?.({ location: location() });
        activeSource = null;
        activeDropTargets = [];
      };
      target.ondragleave = (event) => {
        event.preventDefault();
        activeInput = { clientX: event.clientX, clientY: event.clientY };
        activeDropTargets = [];
        for (const monitor of monitors) {
          monitor.onDropTargetChange?.({ location: location() });
          monitor.onDrag?.({ location: location() });
        }
      };
      return () => {
        target.ondragover = null;
        target.ondrop = null;
        target.ondragleave = null;
      };
    },
    monitorForElements: (monitor: Monitor) => {
      monitors.add(monitor);
      return () => {
        monitors.delete(monitor);
      };
    },
  };
});

const mockUser: User = {
  id: 'u-1',
  email: 'alice@test.com',
  displayName: 'Alice Smith',
  systemRole: 'admin',
  status: 'active',
};

const baseMockChannels: UserChannel[] = [
  { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
  { channelID: 'ch-2', channelName: 'secret', channelType: 'private', role: 1 },
  { channelID: 'ch-3', channelName: 'My Cool Channel!', channelType: 'public', role: 1 },
];
let mockChannels: UserChannel[] = [...baseMockChannels];

const baseMockConversations: UserConversation[] = [
  { conversationID: 'conv-1', type: 'dm', displayName: 'Bob Jones' },
  { conversationID: 'conv-2', type: 'group', displayName: 'Project Team' },
];
let mockConversations: UserConversation[] = [...baseMockConversations];

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

function mockRect(element: Element, rect: Partial<DOMRect>) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      bottom: 20,
      left: 0,
      right: 120,
      width: 120,
      height: 20,
      toJSON: () => ({}),
      ...rect,
    }),
  });
}

function fireDragOver(element: Element, dataTransfer: object, clientY: number) {
  const event = createEvent.dragOver(element, { dataTransfer });
  Object.defineProperty(event, 'clientY', { value: clientY });
  fireEvent(element, event);
}

function fireDrop(element: Element, dataTransfer: object, clientY: number) {
  const event = createEvent.drop(element, { dataTransfer });
  Object.defineProperty(event, 'clientY', { value: clientY });
  fireEvent(element, event);
}

// --- tests ---------------------------------------------------------------

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [];
      return undefined;
    });
    mockChannels = [...baseMockChannels];
    mockConversations = [...baseMockConversations];
    mockUser.systemRole = 'admin';
    mockUser.displayName = 'Alice Smith';
    mockUnreadChannels.clear();
    mockUnreadConversations.clear();
    mockHiddenConversations.clear();
    localStorage.clear();
    window.history.pushState({}, '', '/');
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
    // Admin role badge shows in the user header. The Admin entry was moved
    // from a sidebar nav link into the user-menu DropdownMenuItem, but
    // because the dropdown content stays mounted (Radix), its label is
    // queryable here too.
    const matches = screen.getAllByText('Admin');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('exposes an Admin entry in the user menu for admins', async () => {
    // Admin used to be a top-level sidebar nav link, but it now lives in
    // the user dropdown — open the menu before asserting on the item.
    renderSidebar();
    fireEvent.click(screen.getByLabelText('User menu'));
    expect(await screen.findByTestId('user-menu-admin')).toBeInTheDocument();
  });

  it('renders channel list', () => {
    renderSidebar();
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('does not render a "Browse" header above the channel groups', () => {
    // The "Browse" wrapper header was dropped — sections (Favorites,
    // Channels, DMs, user categories) render directly with their own
    // chevron header, so the bridge label became visual noise.
    renderSidebar();
    expect(screen.queryByText('Browse')).not.toBeInTheDocument();
  });

  it('renders default Channels and Direct Messages section headers when both have items', () => {
    renderSidebar();
    // The grouped sidebar still renders these as default-section headers.
    expect(screen.getAllByText('Channels').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Direct Messages').length).toBeGreaterThan(0);
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
    expect(screen.getByText('general').closest('a')).toHaveClass('font-bold');
    expect(screen.queryByTestId('unread-dot')).not.toBeInTheDocument();
  });

  it('shows unread indicator for conversations', () => {
    mockUnreadConversations.add('conv-1');
    renderSidebar();
    expect(screen.getByText('Bob Jones').closest('a')).toHaveClass('font-bold');
    expect(screen.queryByTestId('unread-dot')).not.toBeInTheDocument();
  });

  it('calls hideConversation when "Close conversation" menu item is clicked', async () => {
    // Closing a DM moved from a dedicated X button into the row's kebab
    // menu so DM rows match the channel-row layout exactly. Open the
    // kebab first (Radix only renders the menu items on click), then
    // pick the menu entry by its per-row data-testid.
    const user = userEvent.setup();
    renderSidebar();

    expect(screen.getByText('Bob Jones')).toBeInTheDocument();

    await user.click(screen.getByTestId('conv-row-menu-conv-1'));
    await user.click(await screen.findByTestId('conv-close-conv-1'));
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
    const nav = screen.getByLabelText('Channels and direct messages');
    const links = nav.querySelectorAll('a');
    const hrefs = Array.from(links).map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/channel/general');
    expect(hrefs).toContain('/channel/secret');
    // "My Cool Channel!" should slugify to "my-cool-channel"
    expect(hrefs).toContain('/channel/my-cool-channel');
  });

  it('drags a channel before another channel and persists sidebar placement', async () => {
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
      getData: vi.fn(),
    };
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-1'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('channel-row-ch-1'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-2/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: '', sidebarPosition: 1000 }),
      });
    });
  });

  it('drops a channel onto a category header and stores that category', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 0 }];
      return undefined;
    });
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    const header = screen.getByTestId('sidebar-group-header-cat-eng');
    mockRect(header, { top: -20, bottom: 0 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-1'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-1'), { dataTransfer });
    fireDragOver(header, dataTransfer, 19);
    fireDrop(header, dataTransfer, 19);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 1000 }),
      });
    });
  });

  it('drops a channel into the first slot just under a category header', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 1000 }];
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], favorite: true },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[2] },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    const header = screen.getByTestId('sidebar-group-header-cat-eng');
    mockRect(header, { top: -20, bottom: 0 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireDragOver(header, dataTransfer, 19);
    fireDrop(header, dataTransfer, 19);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-3/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 500 }),
      });
    });
  });

  it('treats a channel dropped above a category header as the end of the previous category', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-ops', sidebarPosition: 1000 },
      { ...baseMockChannels[2] },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Operations');
    const header = screen.getByTestId('sidebar-group-header-cat-ops');
    mockRect(header, {});
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireDragOver(header, dataTransfer, 1);
    fireDrop(header, dataTransfer, 1);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-3/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 2000 }),
      });
    });
  });

  it('drops a channel on the single separator after a category as the last item in that category', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-ops', sidebarPosition: 1000 },
      { ...baseMockChannels[2] },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-section-tail-drop-cat-eng'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('sidebar-section-tail-drop-cat-eng'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-3/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 2000 }),
      });
    });
  });

  it('commits the visible channel placement on drag end when the browser misses drop', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 1000 }];
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 2000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-1'), { dataTransfer });
    fireEvent.dragEnd(screen.getByTestId('channel-row-ch-2'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-2/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 500 }),
      });
    });
  });

  it('favorites a channel when dropping it into Favorites but ignores category drops there', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], favorite: true },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 1000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Favorites');
    await screen.findByText('Operations');
    mockApiFetch.mockClear();

    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-group-header-__favorites__'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('sidebar-group-header-__favorites__'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-2/favorite', {
        method: 'PUT',
        body: JSON.stringify({ favorite: true }),
      });
    });
    mockApiFetch.mockClear();

    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-group-header-__favorites__'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('sidebar-group-header-__favorites__'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).not.toHaveBeenCalled();
    });
  });

  it('keeps the current route when dropping a channel instead of opening that channel', async () => {
    const onClose = vi.fn();
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar(onClose);

    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-1'), { dataTransfer });
    fireEvent.dragEnd(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    fireEvent.click(screen.getByText('secret').closest('a')!);

    expect(onClose).not.toHaveBeenCalled();
    expect(window.location.pathname).not.toBe('/channel/secret');
  });

  it('shows a drop line while dragging a channel', async () => {
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer, clientX: 24, clientY: 32 });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-1'), { dataTransfer });

    expect(screen.getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
  });

  it('shows the placement line when reordering channels inside the same category', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 1000 }];
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 2000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-1'), { dataTransfer });

    const group = screen.getByTestId('sidebar-group-cat-eng');
    expect(within(group).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
  });

  it('shows a placement line below a channel without jumping to the category end', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 1000 }];
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 2000 },
      { ...baseMockChannels[2], categoryID: 'cat-eng', sidebarPosition: 3000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    const firstRow = screen.getByTestId('channel-row-ch-1');
    mockRect(firstRow, { top: 0, bottom: 20, height: 20 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireDragOver(firstRow, dataTransfer, 19);

    const secondRowWrapper = screen.getByTestId('channel-row-ch-2').parentElement!;
    expect(within(secondRowWrapper).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
    expect(within(screen.getByTestId('sidebar-section-tail-drop-cat-eng')).queryByTestId('sidebar-drop-indicator')).toBeNull();
  });

  it('commits the line above the last channel instead of dropping below it', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 1000 }];
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 2000 },
      { ...baseMockChannels[2], categoryID: 'cat-eng', sidebarPosition: 3000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    const secondRow = screen.getByTestId('channel-row-ch-2');
    mockRect(secondRow, { top: 0, bottom: 20, height: 20 });
    fireEvent.pointerDown(secondRow);
    fireEvent.dragStart(secondRow, { dataTransfer });
    fireDragOver(secondRow, dataTransfer, 19);

    const lastRowWrapper = screen.getByTestId('channel-row-ch-3').parentElement!;
    expect(within(lastRowWrapper).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
    fireDrop(secondRow, dataTransfer, 19);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-2/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 2000 }),
      });
    });
  });

  it('commits the painted channel placement line when a later raw target arrives before paint', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 1000 }];
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 2000 },
      { ...baseMockChannels[2], categoryID: 'cat-eng', sidebarPosition: 3000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    const firstRow = screen.getByTestId('channel-row-ch-1');
    const secondRow = screen.getByTestId('channel-row-ch-2');
    mockRect(secondRow, { top: 0, bottom: 20, height: 20 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireEvent.dragOver(firstRow, { dataTransfer });
    expect(within(firstRow.parentElement!).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
    fireDrop(secondRow, dataTransfer, 19);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-3/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 500 }),
      });
    });
  });

  it('keeps the channel placement line visible when the browser reports a gap', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 1000 }];
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 2000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    const targetRow = screen.getByTestId('channel-row-ch-1');
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer });
    const group = screen.getByTestId('sidebar-group-cat-eng');
    expect(within(group).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();

    fireEvent.dragLeave(targetRow, { dataTransfer });

    expect(within(group).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
  });

  it('reorders favorited conversations together with channels inside Favorites', async () => {
    mockChannels = [
      { ...baseMockChannels[0], favorite: true, sidebarPosition: 1000 },
      { ...baseMockChannels[1], favorite: true, sidebarPosition: 3000 },
    ];
    mockConversations = [
      { ...baseMockConversations[0], favorite: true, sidebarPosition: 2000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    const favorites = screen.getByTestId('sidebar-group-__favorites__');
    const labels = within(favorites).getAllByRole('link').map((link) => link.textContent ?? '');
    expect(labels.findIndex((text) => text.includes('general'))).toBeLessThan(
      labels.findIndex((text) => text.includes('Bob Jones')),
    );
    expect(labels.findIndex((text) => text.includes('Bob Jones'))).toBeLessThan(
      labels.findIndex((text) => text.includes('secret')),
    );

    fireEvent.pointerDown(screen.getByTestId('conversation-row-conv-1'));
    fireEvent.dragStart(screen.getByTestId('conversation-row-conv-1'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('channel-row-ch-1'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/conversations/conv-1/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: '', sidebarPosition: 500 }),
      });
    });
  });

  it('commits the last visible channel placement when dropping from a gap', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 1000 }];
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-eng', sidebarPosition: 2000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    const draggedRow = screen.getByTestId('channel-row-ch-2');
    const targetRow = screen.getByTestId('channel-row-ch-1');
    fireEvent.pointerDown(draggedRow);
    fireEvent.dragStart(draggedRow, { dataTransfer });
    fireEvent.dragOver(targetRow, { dataTransfer });
    fireEvent.dragLeave(targetRow, { dataTransfer });
    fireEvent.dragEnd(draggedRow, { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-2/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 500 }),
      });
    });
  });

  it('drags categories before each other and renumbers their positions', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });
    expect(within(screen.getByTestId('sidebar-group-header-cat-eng')).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
    fireEvent.drop(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-ops', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 1000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-eng', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 2000 }),
      });
    });
  });

  it('drops a category before another category from its header', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    mockChannels = [{ ...baseMockChannels[0], favorite: true }];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-ops', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 1000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-eng', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 2000 }),
      });
    });
  });

  it('uses the visible category placement line as the drop source of truth', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
          { id: 'cat-design', name: 'Design', position: 3000 },
        ];
      }
      return undefined;
    });
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Operations');
    const targetHeader = screen.getByTestId('sidebar-group-header-cat-ops');
    mockRect(targetHeader, { top: 0, bottom: 20, height: 20 });
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-design'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-design'), { dataTransfer });
    fireDragOver(targetHeader, dataTransfer, 1);
    expect(within(targetHeader).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
    fireDrop(targetHeader, dataTransfer, 19);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-eng', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 1000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-design', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 2000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-ops', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 3000 }),
      });
    });
  });

  it('ignores category drops over category bodies', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-ops', sidebarPosition: 1000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Operations');
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-eng'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-section-tail-drop-cat-ops'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('sidebar-section-tail-drop-cat-ops'), { dataTransfer });

    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/v1/sidebar/categories/cat-eng',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('keeps the category placement line visible after crossing a category body', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-ops', sidebarPosition: 1000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Operations');
    const targetHeader = screen.getByTestId('sidebar-group-header-cat-eng');
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireEvent.dragOver(targetHeader, { dataTransfer });
    expect(within(targetHeader).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();

    fireEvent.dragOver(screen.getByTestId('sidebar-section-tail-drop-cat-eng'), { dataTransfer });

    expect(within(targetHeader).getByTestId('sidebar-drop-indicator')).toBeInTheDocument();
  });

  it('accepts a category drop directly on the visible boundary line hitbox', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Operations');
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-category-boundary-drop-cat-eng'), { dataTransfer });
    expect(
      within(screen.getByTestId('sidebar-group-header-cat-eng')).getByTestId('sidebar-drop-indicator'),
    ).toBeInTheDocument();
    fireEvent.drop(screen.getByTestId('sidebar-category-boundary-drop-cat-eng'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-ops', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 1000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-eng', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 2000 }),
      });
    });
  });

  it('commits the last visible category placement after crossing a category body', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    mockChannels = [
      { ...baseMockChannels[0], categoryID: 'cat-eng', sidebarPosition: 1000 },
      { ...baseMockChannels[1], categoryID: 'cat-ops', sidebarPosition: 1000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Operations');
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('sidebar-section-tail-drop-cat-eng'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-ops', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 1000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-eng', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 2000 }),
      });
    });
  });

  it('normalizes category drops that resolve before the dragged category to the next slot', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
          { id: 'cat-design', name: 'Design', position: 3000 },
        ];
      }
      return undefined;
    });
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    const previousHeader = screen.getByTestId('sidebar-group-header-cat-eng');
    mockRect(previousHeader, { top: 0, bottom: 20, height: 20 });
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireDragOver(previousHeader, dataTransfer, 19);
    fireDrop(previousHeader, dataTransfer, 19);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-eng', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 1000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-ops', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 2000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-design', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 3000 }),
      });
    });
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/v1/sidebar/categories/cat-ops',
      expect.objectContaining({
        body: JSON.stringify({ name: undefined, position: 1000 }),
      }),
    );
  });

  it('commits the visible category placement on drag end when the browser misses drop', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') {
        return [
          { id: 'cat-eng', name: 'Engineering', position: 1000 },
          { id: 'cat-ops', name: 'Operations', position: 2000 },
        ];
      }
      return undefined;
    });
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Engineering');
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });
    fireEvent.dragEnd(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-ops', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 1000 }),
      });
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/cat-eng', {
        method: 'PATCH',
        body: JSON.stringify({ name: undefined, position: 2000 }),
      });
    });
  });

  it('uses midpoint sidebar positions when dropping between positioned channels', async () => {
    mockChannels = [
      { ...baseMockChannels[0], sidebarPosition: 1000 },
      { ...baseMockChannels[1], sidebarPosition: 3000 },
      { ...baseMockChannels[2], sidebarPosition: 5000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('channel-row-ch-2'), { dataTransfer });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-3/category', {
        method: 'PUT',
        body: JSON.stringify({ categoryID: '', sidebarPosition: 2000 }),
      });
    });
  });

  it('stores and applies the Direct Messages A-Z sort preference', async () => {
    mockConversations = [
      { conversationID: 'conv-b', type: 'dm', displayName: 'Zoe' },
      { conversationID: 'conv-a', type: 'dm', displayName: 'Amy' },
    ];
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByTestId('sidebar-dm-sort-menu'));
    await user.click(await screen.findByText('A-Z'));

    expect(localStorage.getItem('sidebar.conversationSort')).toBe('az');
    const labels = screen.getAllByRole('link').map((link) => link.textContent ?? '');
    expect(labels.findIndex((text) => text.includes('Amy'))).toBeLessThan(
      labels.findIndex((text) => text.includes('Zoe')),
    );
  });

  it('keeps the create-channel affordance hidden for guests', () => {
    mockUser.systemRole = 'guest';
    renderSidebar();
    expect(screen.queryByLabelText('Create channel')).not.toBeInTheDocument();
  });

  it('collapses a channel section but keeps unread channels visible', async () => {
    mockUnreadChannels.add('ch-1');
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-group-toggle-__channels__'));
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });
});
