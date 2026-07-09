import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, createEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import type { User, UserChannel, UserConversation } from '@/types';

// --- mocks ---------------------------------------------------------------

const mockApiFetch = vi.hoisted(() => vi.fn());

// The reorder now densifies the section and writes each changed row through
// /{kind}/{id}/category. Assert the dragged row's PUT went to the right section
// at a POSITIVE dense position (the exact integer is unit-tested in
// sidebar-reorder.test.ts) — crucially, never a negative/collision value again.
function lastMoveBody(): { itemType: string; itemID: string; section: string; categoryID: string; afterType: string; afterID: string } | undefined {
  const call = [...mockApiFetch.mock.calls].reverse().find(([url]) => url === '/api/v1/sidebar/move');
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}
function lastCategoryMoveBody(id: string): { afterID: string } | undefined {
  const call = [...mockApiFetch.mock.calls].reverse().find(([url]) => url === `/api/v1/sidebar/categories/${id}/move`);
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

vi.mock('@/lib/api', () => ({
  // Answer the server-owned move endpoints with their (empty) response
  // shapes whenever a test's mockImplementation doesn't — the hooks read
  // `res.updates` / `res.categories` from real responses.
  apiFetch: async (...args: unknown[]) => {
    const res = await mockApiFetch(...args);
    if (res !== undefined) return res;
    const url = String(args[0]);
    if (url === '/api/v1/sidebar/move') return { updates: [] };
    if (/\/sidebar\/categories\/[^/]+\/move$/.test(url)) return { categories: [] };
    return undefined;
  },
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
      canDrag,
      getInitialData,
      onDragStart,
      onDrop,
    }: {
      dragHandle?: Element | null;
      element: HTMLElement;
      canDrag?: (args: { input: { button: number } }) => boolean;
      getInitialData?: () => Record<string, unknown>;
      onDragStart?: () => void;
      onDrop?: () => void;
    }) => {
      const handle = (dragHandle ?? element) as HTMLElement;
      handle.ondragstart = (event) => {
        // The real adapter consults canDrag with the initiating input before
        // starting a drag — a false return means the drag never begins. jsdom
        // drag events carry no button unless a test sets one; default to the
        // primary button like a real left-button drag.
        if (canDrag && !canDrag({ input: { button: event.button ?? 0 } })) return;
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
      getIsSticky,
    }: {
      element: Element;
      getData?: (args: { input: { clientX: number; clientY: number }; element: Element }) => Record<string | symbol, unknown>;
      getIsSticky?: () => boolean;
    }) => {
      const target = element as HTMLElement;
      const readData = (event: DragEvent) => {
        // The real adapter re-evaluates getIsSticky on every drag pass to
        // decide whether a previous target survives leaving its box. The mock
        // consults it the same way but keeps its single-target model — a
        // dragleave still models "pointer over a gap, no target", so the
        // Sidebar's visible-indicator drop fallback stays exercised.
        getIsSticky?.();
        return getData?.({
          input: {
            clientX: event.clientX,
            clientY: event.clientY,
          },
          element,
        }) ?? {};
      };
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

let mockHiddenConversations = new Set<string>();
const mockHideConversation = vi.fn((id: string) => {
  mockHiddenConversations = new Set(mockHiddenConversations).add(id);
});

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadThreadNotifications: new Set(),
    hiddenConversations: mockHiddenConversations,
    hideConversation: mockHideConversation,
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
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
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

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
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
    mockHiddenConversations.clear();
    localStorage.clear();
    window.history.pushState({}, '', '/');
    delete window.Capacitor;
    setMobileMatch(false);
  });

  it('keeps the mobile channel list scrollable instead of registering row drag handlers', async () => {
    setMobileMatch(true);
    renderSidebar();

    const scrollArea = screen.getByTestId('sidebar-scroll-area');
    const channelRow = screen.getByTestId('channel-row-ch-1') as HTMLElement;

    expect(scrollArea).toHaveClass('min-h-0', 'flex-1', 'mobile:touch-pan-y');
    expect(scrollArea.querySelector('[data-slot="scroll-area-viewport"]')).toHaveClass('overflow-y-auto');
    expect(channelRow).not.toHaveClass('cursor-grab');
    await waitFor(() => {
      expect(channelRow.ondragstart).toBeNull();
    });
  });

  it('renders channel list', () => {
    renderSidebar();
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('shows the Activity row with an unread count badge', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [];
      if (url === '/api/v1/activity') return { items: [], unread: 4 };
      return undefined;
    });
    renderSidebar();
    expect(screen.getByText('Activity').closest('a')).toHaveAttribute('href', '/activity');
    const badge = await screen.findByTestId('activity-unread-badge');
    expect(badge).toHaveTextContent('4');
  });

  it('caps the Activity unread badge at 99+', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [];
      if (url === '/api/v1/activity') return { items: [], unread: 150 };
      return undefined;
    });
    renderSidebar();
    expect(await screen.findByTestId('activity-unread-badge')).toHaveTextContent('99+');
  });

  it('uses the same mobile row sizing across top links, section headers, channels, and DMs', () => {
    renderSidebar();

    expect(screen.getByText('Directory').closest('a')).toHaveClass('mobile:h-12', 'mobile:px-3', 'mobile:text-base');
    expect(screen.getByText('Channels').closest('[role="button"]')).toHaveClass('mobile:h-12', 'mobile:px-3', 'mobile:text-base');
    expect(screen.getByText('general').closest('a')).toHaveClass('mobile:h-12', 'mobile:pl-3', 'mobile:text-base');
    expect(screen.getByText('Bob Jones').closest('a')).toHaveClass('mobile:h-12', 'mobile:pl-3', 'mobile:text-base');
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

  it('initializes the DM sort from the stored az preference', () => {
    localStorage.setItem('sidebar.conversationSort', 'az');
    renderSidebar();
    // The az-preference branch of the lazy initializer runs without error.
    expect(screen.getByText('Direct Messages')).toBeInTheDocument();
  });

  it('persists the DM sort preference when changed via the sort menu', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByLabelText('Sort direct messages'));
    await user.click(await screen.findByText('A-Z'));
    expect(localStorage.getItem('sidebar.conversationSort')).toBe('az');

    await user.click(screen.getByLabelText('Sort direct messages'));
    await user.click(await screen.findByText('Recent activity'));
    expect(localStorage.getItem('sidebar.conversationSort')).toBe('recent');
  });

  it('shows unread indicator for channels', () => {
    // Unread now comes from the server-computed list-cache flag, not a context Set.
    mockChannels = mockChannels.map((c) => (c.channelID === 'ch-1' ? { ...c, unread: true, unreadCount: 1 } : c));
    renderSidebar();
    expect(screen.getByText('general').closest('a')).toHaveClass('font-bold');
    expect(screen.queryByTestId('unread-dot')).not.toBeInTheDocument();
  });

  it('shows unread indicator for conversations', () => {
    mockConversations = mockConversations.map((c) => (c.conversationID === 'conv-1' ? { ...c, unread: true, unreadCount: 1 } : c));
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
      // The drop is reported as an event — item, section, anchor — never a
      // client-computed position. Landing before ch-1 = the top (no anchor).
      expect(lastMoveBody()).toMatchObject({ itemType: 'channel', itemID: 'ch-2', section: 'channels', afterID: '' });
    });
  });

  it('favorites a channel when it is dropped onto the Favorites header', async () => {
    // One existing favorite makes the Favorites section render.
    mockChannels = [
      { ...baseMockChannels[0], favorite: true },
      { ...baseMockChannels[1] },
      { ...baseMockChannels[2] },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    const header = screen.getByTestId('sidebar-group-header-__favorites__');
    mockRect(header, { top: -20, bottom: 0 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireDragOver(header, dataTransfer, 19);
    fireDrop(header, dataTransfer, 19);

    await waitFor(() => {
      // The favorite flip is the SERVER's decision — the event just targets
      // the Favorites section.
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-2', section: 'favorites' });
    });
  });

  it('unfavorites a favorited channel when it is dropped into a regular section', async () => {
    // ch-2 is favorited (renders in Favorites); dropping it back onto a
    // regular channel row schedules an unfavorite.
    mockChannels = [
      { ...baseMockChannels[0] },
      { ...baseMockChannels[1], favorite: true },
      { ...baseMockChannels[2] },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-1'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('channel-row-ch-1'), { dataTransfer });

    await waitFor(() => {
      // Landing in a regular section un-favorites server-side.
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-2', section: 'channels' });
    });
  });

  it('ignores a channel dropped onto the Direct Messages header', async () => {
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    const dmHeader = screen.getByTestId('sidebar-group-header-__dms__');
    mockRect(dmHeader, { top: -20, bottom: 0 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-1'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-1'), { dataTransfer });
    fireDragOver(dmHeader, dataTransfer, 19);
    fireDrop(dmHeader, dataTransfer, 19);

    // A channel cannot be filed under Direct Messages → no move event.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/sidebar/move', expect.anything());
  });

  it('drops a channel into a position gap and lands on the midpoint', async () => {
    mockChannels = [
      { ...baseMockChannels[0], sidebarPosition: 1000 },
      { ...baseMockChannels[1], sidebarPosition: 3000 },
      { ...baseMockChannels[2], sidebarPosition: 5000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    // Drag ch-3 between ch-1 and ch-2 → the event anchors after ch-1; the
    // server decides what number that slot becomes.
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('channel-row-ch-2'), { dataTransfer });

    await waitFor(() => {
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'channels', afterType: 'channel', afterID: 'ch-1' });
    });
  });

  it('dropping on the bottom half of a MIDDLE row resolves to a row slot (not the section end)', async () => {
    mockChannels = [
      { ...baseMockChannels[0], sidebarPosition: 1000 },
      { ...baseMockChannels[1], sidebarPosition: 3000 },
      { ...baseMockChannels[2], sidebarPosition: 5000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    // Bottom half of ch-1 (a middle row): index bumps past ch-1 but stays
    // below the section's drop count → channelDropAreaForIndex returns 'row'.
    const target = screen.getByTestId('channel-row-ch-1');
    mockRect(target, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireDragOver(target, dataTransfer, 19);
    fireDrop(target, dataTransfer, 19);

    await waitFor(() => {
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'channels', afterType: 'channel', afterID: 'ch-1' });
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
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-1', section: 'category', categoryID: 'cat-eng', afterID: '' });
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
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'category', categoryID: 'cat-eng', afterID: '' });
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
      // End of cat-eng = after its last row (ch-1).
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'category', categoryID: 'cat-eng', afterType: 'channel', afterID: 'ch-1' });
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
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'category', categoryID: 'cat-eng', afterType: 'channel', afterID: 'ch-1' });
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
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-2', section: 'category', categoryID: 'cat-eng' });
    });
  });

  it('renders without crashing when channel and conversation data are undefined', () => {
    // Exercises the `?? []` fallbacks for absent channels/conversations.
    mockChannels = undefined as unknown as typeof mockChannels;
    mockConversations = undefined as unknown as typeof mockConversations;
    const { container } = renderSidebar();
    expect(container.firstChild).toBeTruthy();
  });

  it('deletes a user category through the confirm dialog', async () => {
    const deleted: string[] = [];
    mockApiFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 0 }];
      if (opts?.method === 'DELETE') {
        deleted.push(url);
        return undefined;
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderSidebar();

    await screen.findByText('Engineering');
    await user.click(screen.getByTestId('sidebar-category-menu-cat-eng'));
    await user.click(await screen.findByTestId('sidebar-category-delete-cat-eng'));
    // The confirm dialog opens; confirming fires the delete mutation.
    expect(await screen.findByText('Delete category?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete category' }));
    await waitFor(() => expect(deleted).toContain('/api/v1/sidebar/categories/cat-eng'));
  });

  it('closes the delete-category dialog without deleting when dismissed', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 0 }];
      return undefined;
    });
    const user = userEvent.setup();
    renderSidebar();

    await screen.findByText('Engineering');
    await user.click(screen.getByTestId('sidebar-category-menu-cat-eng'));
    await user.click(await screen.findByTestId('sidebar-category-delete-cat-eng'));
    expect(await screen.findByText('Delete category?')).toBeInTheDocument();
    // Escape dismisses the dialog (onOpenChange(false) → clears the target).
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Delete category?')).not.toBeInTheDocument());
  });

  it('shows a fallback error when creating a category rejects with a non-Error', async () => {
    mockApiFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return Promise.reject('boom-string');
      if (url === '/api/v1/sidebar/categories') return [];
      return undefined;
    });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByText('+ Add category'));
    const input = screen.getByTestId('sidebar-new-category-input');
    await user.type(input, 'Engineering{Enter}');
    expect(await screen.findByText('Could not create category')).toBeInTheDocument();
  });

  it('keeps only active/unread items visible when sections are collapsed', () => {
    // ch-1 (general) is the active channel; conv-1 is unread.
    mockConversations = mockConversations.map((c) => (c.conversationID === 'conv-1' ? { ...c, unread: true } : c));
    window.history.pushState({}, '', '/channel/general');
    renderSidebar();

    // Collapse both default sections so the visible-item filter runs.
    fireEvent.click(screen.getByTestId('sidebar-group-toggle-__channels__'));
    fireEvent.click(screen.getByTestId('sidebar-group-toggle-__dms__'));

    // Active channel and unread DM survive; the read ones are filtered out.
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.queryByText('Project Team')).not.toBeInTheDocument();
  });

  it('marks the Threads link active on the /threads route', () => {
    window.history.pushState({}, '', '/threads');
    renderSidebar();
    const link = screen.getByText('Threads').closest('a')!;
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Drafts link active and shows the exact draft count on the /drafts route', async () => {
    const drafts = Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      userID: 'u-1',
      parentID: 'ch-1',
      parentType: 'channel',
      parentMessageID: '',
      body: 'd',
      attachmentIDs: [],
      updatedAt: '2026-05-03T10:00:00Z',
      createdAt: '2026-05-03T10:00:00Z',
    }));
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [];
      if (url === '/api/v1/drafts') return drafts;
      return undefined;
    });
    window.history.pushState({}, '', '/drafts');
    renderSidebar();
    const link = screen.getByText('Drafts').closest('a')!;
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(await within(link).findByText('3')).toBeInTheDocument();
  });

  it('toggles a section collapsed via the keyboard (Enter and Space)', () => {
    renderSidebar();
    const toggle = screen.getByTestId('sidebar-group-toggle-__channels__');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(toggle, { key: ' ' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // A non-activating key is ignored.
    fireEvent.keyDown(toggle, { key: 'a' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('caps the threads badge at "99+" when more than 99 threads are unread', async () => {
    const manyThreads = Array.from({ length: 120 }, (_, i) => ({
      parentID: 'ch-1',
      parentType: 'channel' as const,
      threadRootID: `t-${i}`,
      rootAuthorID: 'u-2',
      rootBody: 'root',
      rootCreatedAt: '2026-05-03T10:00:00Z',
      replyCount: 1,
      latestActivityAt: '2026-05-03T10:00:00Z',
    }));
    const notifications = manyThreads.map((t) => t.threadRootID);
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [];
      if (url === '/api/v1/threads') return manyThreads;
      if (url === '/api/v1/user-state') {
        return {
          channelNotifications: [],
          threadNotifications: notifications,
          threadSeen: {},
          hiddenConversations: [],
        };
      }
      return undefined;
    });
    renderSidebar();
    const badge = await screen.findByTestId('threads-unread-badge');
    expect(badge).toHaveTextContent('99+');
  });

  it('caps the drafts badge at "99+" when there are more than 99 drafts', async () => {
    const manyDrafts = Array.from({ length: 120 }, (_, i) => ({
      id: String(i),
      userID: 'u-1',
      parentID: 'ch-1',
      parentType: 'channel',
      parentMessageID: '',
      body: 'draft',
      attachmentIDs: [],
      updatedAt: '2026-05-03T10:00:00Z',
      createdAt: '2026-05-03T10:00:00Z',
    }));
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [];
      if (url === '/api/v1/drafts') return manyDrafts;
      return undefined;
    });
    renderSidebar();
    expect(await screen.findByText('99+')).toBeInTheDocument();
  });

  it('emits drag debug logs when the sidebar DnD debug flag is enabled', async () => {
    localStorage.setItem('ex.sidebarDndDebug', '1');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-1'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('channel-row-ch-1'), { dataTransfer });

    await waitFor(() => {
      expect(debugSpy.mock.calls.some((c) => String(c[0]).includes('[sidebar-dnd]'))).toBe(true);
    });
    debugSpy.mockRestore();
  });

  it('emits category-drag debug logs across multiple drop-target changes', async () => {
    localStorage.setItem('ex.sidebarDndDebug', '1');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
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
    await screen.findByText('Operations');

    const engHeader = screen.getByTestId('sidebar-group-header-cat-eng');
    mockRect(engHeader, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    // Two drag-over passes at different edges produce distinct resolutions,
    // so the category resolution/monitor debug logs run (not deduped).
    fireDragOver(engHeader, dataTransfer, 2);
    fireDragOver(engHeader, dataTransfer, 18);
    fireDrop(engHeader, dataTransfer, 18);

    await waitFor(() => {
      expect(
        debugSpy.mock.calls.some((c) => String(c[0]).includes('category')),
      ).toBe(true);
    });
    debugSpy.mockRestore();
  });

  it('drops a category at the end when released past the last category header', async () => {
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
    await screen.findByText('Operations');
    mockApiFetch.mockClear();

    // Drag cat-eng over the BOTTOM edge of the last category (cat-ops). The
    // bottom edge resolves via nextCategoryTarget(cat-ops); since cat-ops has
    // no successor the slot collapses to CATEGORY_DROP_END (the `?? END` path).
    const opsHeader = screen.getByTestId('sidebar-group-header-cat-ops');
    mockRect(opsHeader, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-eng'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });
    fireDragOver(opsHeader, dataTransfer, 18);
    fireDrop(opsHeader, dataTransfer, 18);

    await waitFor(() => {
      const calls = mockApiFetch.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.startsWith('/api/v1/sidebar/categories/'))).toBe(true);
    });
  });

  it('reorders categories when one category header is dropped onto another', async () => {
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
    await screen.findByText('Operations');
    mockApiFetch.mockClear();

    const target = screen.getByTestId('sidebar-group-header-cat-eng');
    mockRect(target, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('sidebar-group-header-cat-ops'));
    fireEvent.dragStart(screen.getByTestId('sidebar-group-header-cat-ops'), { dataTransfer });
    fireDragOver(target, dataTransfer, 2);
    fireDrop(target, dataTransfer, 2);

    // Reordering persists the new positions via per-category PUTs.
    await waitFor(() => {
      const calls = mockApiFetch.mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.startsWith('/api/v1/sidebar/categories/'))).toBe(true);
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
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-2', section: 'favorites' });
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
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    fireEvent.click(screen.getByText('secret').closest('a')!);

    expect(onClose).not.toHaveBeenCalled();
    expect(window.location.pathname).not.toBe('/channel/secret');
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
    fireDrop(secondRow, dataTransfer, 19);

    await waitFor(() => {
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'category', categoryID: 'cat-eng' });
    });
  });


  it('ignores a conversation dropped onto a category header (categories hold channels only)', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/sidebar/categories') return [{ id: 'cat-eng', name: 'Engineering', position: 0 }];
      return undefined;
    });
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    const header = await screen.findByTestId('sidebar-group-header-cat-eng');
    mockRect(header, { top: -20, bottom: 0 });
    fireEvent.pointerDown(screen.getByTestId('conversation-row-conv-1'));
    fireEvent.dragStart(screen.getByTestId('conversation-row-conv-1'), { dataTransfer });
    fireDragOver(header, dataTransfer, 19);
    fireDrop(header, dataTransfer, 19);

    // A conversation can only be favorited via drop, never categorized.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/sidebar/move', expect.anything());
  });

  it('ignores a favorited conversation dragged over a channel row outside Favorites', async () => {
    // conv-1 is favorited, so its row is draggable. Dropping it onto a channel
    // in the regular channels section must be rejected — resolveDropPayload
    // returns null for conversation drops on non-Favorites channel-targets.
    mockConversations = [{ ...baseMockConversations[0], favorite: true, sidebarPosition: 1000 }];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Favorites');
    const target = screen.getByTestId('channel-row-ch-1');
    mockRect(target, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('conversation-row-conv-1'));
    fireEvent.dragStart(screen.getByTestId('conversation-row-conv-1'), { dataTransfer });
    fireDragOver(target, dataTransfer, 5);
    fireDrop(target, dataTransfer, 5);

    await new Promise((r) => setTimeout(r, 0));
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/sidebar/move', expect.anything());
  });

  it('repositions a favorited conversation dragged onto the Favorites section header', async () => {
    // A favorited conversation is draggable. Dropping it on the Favorites header
    // resolves via channelDropFromSectionHeader (the conversation branch) and
    // commits a conversation-category mutation back into Favorites.
    mockChannels = [{ ...baseMockChannels[0], favorite: true, sidebarPosition: 1000 }];
    mockConversations = [{ ...baseMockConversations[0], favorite: true, sidebarPosition: 2000 }];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    const header = await screen.findByTestId('sidebar-group-header-__favorites__');
    mockRect(header, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('conversation-row-conv-1'));
    fireEvent.dragStart(screen.getByTestId('conversation-row-conv-1'), { dataTransfer });
    fireDragOver(header, dataTransfer, 5);
    fireDrop(header, dataTransfer, 5);

    await waitFor(() => {
      expect(lastMoveBody()).toMatchObject({ itemType: 'conversation', itemID: 'conv-1', section: 'favorites' });
    });
  });

  it('steps below a position-1 first favorite when dropping before it', async () => {
    mockChannels = [
      { ...baseMockChannels[0], favorite: true, sidebarPosition: 1 },
      { ...baseMockChannels[1], favorite: true, sidebarPosition: 2000 },
      { ...baseMockChannels[2], favorite: true, sidebarPosition: 4000 },
    ];
    mockConversations = [];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    // Drop ch-3 before the first favorite (position 1) in Favorites →
    // 1 - STEP(1000) = -999 via the sidebar-item position helper.
    const first = screen.getByTestId('channel-row-ch-1');
    mockRect(first, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireDragOver(first, dataTransfer, 2);
    fireDrop(first, dataTransfer, 2);

    await waitFor(() => {
      // No client position at all anymore: the event just says "top of
      // Favorites"; the server renumbers however it needs to.
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'favorites', afterID: '' });
    });
  });

  it('steps below a position-1 first channel when dropping before it', async () => {
    mockChannels = [
      { ...baseMockChannels[0], sidebarPosition: 1 },
      { ...baseMockChannels[1], sidebarPosition: 2000 },
      { ...baseMockChannels[2], sidebarPosition: 4000 },
    ];
    mockConversations = [];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    // Drop ch-3 before ch-1 (position 1) → after(1) is not > 1, so the
    // step-below branch applies: 1 - STEP(1000) = -999.
    const first = screen.getByTestId('channel-row-ch-1');
    mockRect(first, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-3'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-3'), { dataTransfer });
    fireDragOver(first, dataTransfer, 2);
    fireDrop(first, dataTransfer, 2);

    await waitFor(() => {
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'channels', afterID: '' });
    });
  });

  it('appends a favorite dropped past the last item one step beyond it', async () => {
    mockChannels = [
      { ...baseMockChannels[0], favorite: true, sidebarPosition: 1000 },
      { ...baseMockChannels[1], favorite: true, sidebarPosition: 3000 },
    ];
    mockConversations = [];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    // Drag ch-1 onto the bottom half of the last favorite (ch-2) → inserts
    // after it → before(3000) + STEP(1000) = 4000.
    const last = screen.getByTestId('channel-row-ch-2');
    mockRect(last, { top: 0, bottom: 20 });
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-1'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-1'), { dataTransfer });
    fireDragOver(last, dataTransfer, 18);
    fireDrop(last, dataTransfer, 18);

    await waitFor(() => {
      // Past the last favorite (ch-2) → anchored after it.
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-1', section: 'favorites', afterType: 'channel', afterID: 'ch-2' });
    });
  });

  it('computes a midpoint that straddles a favorited conversation neighbor', async () => {
    mockChannels = [
      { ...baseMockChannels[0], favorite: true, sidebarPosition: 1000 },
      { ...baseMockChannels[1], favorite: true, sidebarPosition: 5000 },
    ];
    mockConversations = [
      { ...baseMockConversations[0], favorite: true, sidebarPosition: 3000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    // Drag ch-2 and drop onto the favorited conversation conv-1 → the
    // position helper reads the conversation neighbor's position (3000) as
    // the `after`, yielding the midpoint between ch-1 (1000) and conv-1.
    fireEvent.pointerDown(screen.getByTestId('channel-row-ch-2'));
    fireEvent.dragStart(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('conversation-row-conv-1'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('conversation-row-conv-1'), { dataTransfer });

    await waitFor(() => {
      // Landing before the favorited conversation = after ch-1, mixing the
      // two row kinds in one anchor namespace.
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-2', section: 'favorites', afterType: 'channel', afterID: 'ch-1' });
    });
  });

  it('places a favorite dropped between two others at the midpoint position', async () => {
    mockChannels = [
      { ...baseMockChannels[0], favorite: true, sidebarPosition: 1000 },
      { ...baseMockChannels[1], favorite: true, sidebarPosition: 3000 },
    ];
    mockConversations = [
      { ...baseMockConversations[0], favorite: true, sidebarPosition: 5000 },
    ];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    // Drag conv-1 between ch-1 (1000) and ch-2 (3000) → midpoint 2000.
    fireEvent.pointerDown(screen.getByTestId('conversation-row-conv-1'));
    fireEvent.dragStart(screen.getByTestId('conversation-row-conv-1'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('channel-row-ch-2'), { dataTransfer });

    await waitFor(() => {
      expect(lastMoveBody()).toMatchObject({ itemType: 'conversation', itemID: 'conv-1', section: 'favorites', afterType: 'channel', afterID: 'ch-1' });
    });
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
      expect(lastMoveBody()).toMatchObject({ itemType: 'conversation', itemID: 'conv-1', section: 'favorites' });
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
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-2', section: 'category', categoryID: 'cat-eng' });
    });
  });

  it('refuses to start a row drag from a non-primary mouse button', async () => {
    // canDrag gates drags on the primary button — a right-button (context
    // menu) press must never lift the row or commit a reorder.
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    const row = await screen.findByTestId('channel-row-ch-1');
    // fireEvent.dragStart can't carry a button (jsdom has no DragEvent and the
    // Event constructor drops MouseEvent init keys) — dispatch a real
    // MouseEvent so the adapter's canDrag sees button 2.
    act(() => {
      row.dispatchEvent(
        new MouseEvent('dragstart', { bubbles: true, cancelable: true, button: 2 }),
      );
    });

    // The drag never started: the row is not collapsed out of its slot…
    expect(row.style.opacity).not.toBe('0');

    // …and dropping on another row commits no server move.
    fireEvent.drop(screen.getByTestId('channel-row-ch-2'), { dataTransfer });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lastMoveBody()).toBeUndefined();
  });

  it('collapses a dragged favorite conversation row and restores it when the drag ends', async () => {
    mockConversations = [{ ...baseMockConversations[0], favorite: true, sidebarPosition: 1000 }];
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    renderSidebar();

    await screen.findByText('Favorites');
    const row = screen.getByTestId('conversation-row-conv-1');
    fireEvent.pointerDown(row);
    fireEvent.dragStart(row, { dataTransfer });
    // While in flight the original slot collapses (Slack-style lift-out).
    expect(row.style.opacity).toBe('0');

    // A cancelled/finished native drag (dragend) restores the row.
    fireEvent.dragEnd(row, { dataTransfer });
    expect(row.style.opacity).toBe('');
  });

  it('renders normally when localStorage is unavailable for the DnD debug flag (private mode)', async () => {
    const original = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === 'ex.sidebarDndDebug') throw new Error('storage denied');
      return original.call(this, key);
    });
    try {
      renderSidebar();
      expect(await screen.findByTestId('channel-row-ch-1')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
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
    expect(screen.getByTestId('sidebar-drop-gap-cat-cat-eng')).toBeInTheDocument();
    fireEvent.drop(screen.getByTestId('sidebar-group-header-cat-eng'), { dataTransfer });

    await waitFor(() => {
      // One event: "cat-ops lands at the top" — the server renumbers all.
      expect(lastCategoryMoveBody('cat-ops')).toEqual({ afterID: '' });
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
      expect(lastCategoryMoveBody('cat-ops')).toEqual({ afterID: '' });
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
    expect(screen.getByTestId('sidebar-drop-gap-cat-cat-ops')).toBeInTheDocument();
    fireDrop(targetHeader, dataTransfer, 19);

    await waitFor(() => {
      // Design landed after Engineering (the painted line's slot).
      expect(lastCategoryMoveBody('cat-design')).toEqual({ afterID: 'cat-eng' });
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

  it('keeps the category placement gap visible after crossing a category body', async () => {
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
    expect(screen.getByTestId('sidebar-drop-gap-cat-cat-eng')).toBeInTheDocument();

    fireEvent.dragOver(screen.getByTestId('sidebar-section-tail-drop-cat-eng'), { dataTransfer });

    expect(screen.getByTestId('sidebar-drop-gap-cat-cat-eng')).toBeInTheDocument();
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
    expect(screen.getByTestId('sidebar-drop-gap-cat-cat-eng')).toBeInTheDocument();
    fireEvent.drop(screen.getByTestId('sidebar-category-boundary-drop-cat-eng'), { dataTransfer });

    await waitFor(() => {
      expect(lastCategoryMoveBody('cat-ops')).toEqual({ afterID: '' });
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
      expect(lastCategoryMoveBody('cat-ops')).toEqual({ afterID: '' });
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
      // The dragged category can't anchor on its own old slot: normalized to
      // "after Engineering", never "before itself".
      expect(lastCategoryMoveBody('cat-ops')).toEqual({ afterID: 'cat-eng' });
    });
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
      expect(lastCategoryMoveBody('cat-ops')).toEqual({ afterID: '' });
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
      // Between ch-1 and ch-2 = anchored after ch-1; the gap arithmetic is
      // the server's job now.
      expect(lastMoveBody()).toMatchObject({ itemID: 'ch-3', section: 'channels', afterType: 'channel', afterID: 'ch-1' });
    });
  });

  it('the DM sort trigger leaves the layout on mobile (display:none, not just invisible)', () => {
    renderSidebar();
    // opacity-0 alone still hit-tests AND occupies flex space: it was an
    // INVISIBLE tappable target beside the always-visible mobile "+" and its
    // 20px slot pushed that "+" out of line with the Channels "+". hidden
    // removes it from both hit-testing and layout.
    const trigger = screen.getByTestId('sidebar-dm-sort-menu');
    expect(trigger).toHaveClass('opacity-0', 'mobile:hidden');
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
    mockChannels = mockChannels.map((c) => (c.channelID === 'ch-1' ? { ...c, unread: true } : c));
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-group-toggle-__channels__'));
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });
});
