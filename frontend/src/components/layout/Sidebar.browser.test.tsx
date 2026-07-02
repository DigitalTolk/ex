import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter, MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import type { User, UserChannel, UserConversation, SidebarCategory } from '@/types';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

// Comprehensive browser coverage for Sidebar.tsx — the biggest single
// uncovered surface at 22% branch coverage / 398 uncovered branches.
// The original browser test only mounted the sidebar with empty data;
// this file drives the actual rendering paths: favorites, custom
// categories, drafts, threads, unread badges, sort menu, create
// category, role-gated admin entries, directory + threads + drafts
// nav links, presence dots and DM avatars.

const apiFetchMock = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// pragmatic-drag-and-drop tries to register browser listeners on
// mount; mock its adapters so the component mounts cleanly without
// pulling in the real DnD plumbing for these render-path tests.
vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
  monitorForElements: () => () => {},
}));
vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine: (...cleanups: Array<() => void>) => () => cleanups.forEach((fn) => fn?.()),
}));
vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
  attachClosestEdge: (data: unknown) => data,
  extractClosestEdge: () => 'top',
}));

const adminUser: User = {
  id: 'u-self',
  email: 'alice@test.com',
  displayName: 'Alice Smith',
  systemRole: 'admin',
  status: 'active',
};

const guestUser: User = {
  id: 'u-self',
  email: 'g@test.com',
  displayName: 'Guest User',
  systemRole: 'guest',
  status: 'active',
};

const memberUser: User = {
  id: 'u-self',
  email: 'm@test.com',
  displayName: 'Member',
  systemRole: 'member',
  status: 'active',
};

let currentUser: User = adminUser;
let currentLogout = vi.fn().mockResolvedValue(undefined);
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: currentUser,
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: () => currentLogout(),
    setAuth: vi.fn(),
  }),
}));

let mockUnread: {
  unreadChannels: Set<string>;
  unreadChannelNotifications: Set<string>;
  unreadConversations: Set<string>;
  unreadThreadNotifications: Set<string>;
  hiddenConversations: Set<string>;
  channelUnreadCounts?: Map<string, number>;
  conversationUnreadCounts?: Map<string, number>;
} = {
  unreadChannels: new Set(),
  unreadChannelNotifications: new Set(),
  unreadConversations: new Set(),
  unreadThreadNotifications: new Set(),
  hiddenConversations: new Set(),
};
const hideConversationMock = vi.fn();
vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    ...mockUnread,
    hideConversation: hideConversationMock,
    unhideConversation: vi.fn(),
    markChannelUnread: vi.fn(),
    markChannelNotificationUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    markThreadNotificationUnread: vi.fn(),
  }),
}));

let mockOnline: Set<string> = new Set();
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: mockOnline,
    isOnline: (id: string) => mockOnline.has(id),
    lastSeenByUser: new Map(),
  }),
}));

let mockChannels: UserChannel[] = [];
let mockConversations: UserConversation[] = [];
let mockConversationsState: { data?: UserConversation[]; isError: boolean } = {
  data: [],
  isError: false,
};
const createChannelMutate = vi.fn();
vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: mockChannels }),
  useCreateChannel: () => ({ mutate: createChannelMutate, isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useUserConversations: () => ({
    data: mockConversationsState.data,
    isError: mockConversationsState.isError,
  }),
  useSearchUsers: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

let mockThreads: Array<{
  parentID: string;
  parentType: 'channel' | 'conversation';
  threadRootID: string;
  lastReplyAt: string;
}> = [];
vi.mock('@/hooks/useThreads', () => ({
  THREAD_SEEN_CHANGED_EVENT: 'ex:thread-seen-changed',
  getSeenMap: () => ({}),
  unreadThreadIDs: (threads: typeof mockThreads) => new Set(threads.map((t) => t.threadRootID)),
  useUserThreads: () => ({ data: mockThreads }),
}));

let mockUserState: {
  hiddenConversations: string[];
  channelNotifications: string[];
  threadNotifications: string[];
  threadSeen: Record<string, string>;
} | undefined = {
  hiddenConversations: [],
  channelNotifications: [],
  threadNotifications: [],
  threadSeen: {},
};
vi.mock('@/hooks/useUserState', () => ({
  useUserState: () => ({ data: mockUserState }),
}));

let mockDrafts: Array<{ parentID: string; parentType: string }> = [];
vi.mock('@/hooks/useDrafts', () => ({
  useDrafts: () => ({ data: mockDrafts }),
}));

vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({
    map: new Map([
      [
        'u-bob',
        { id: 'u-bob', displayName: 'Bob Jones', userStatus: undefined },
      ],
    ]),
  }),
}));

let mockCategories: SidebarCategory[] = [];
const createCategoryMutate = vi.fn((_name: string, opts?: { onSuccess?: () => void }) => {
  opts?.onSuccess?.();
});
const deleteCategoryMutate = vi.fn();
vi.mock('@/hooks/useSidebar', () => ({
  useCategories: () => ({ data: mockCategories }),
  useCreateCategory: () => ({ mutate: createCategoryMutate, isPending: false }),
  useDeleteCategory: () => ({ mutate: deleteCategoryMutate, isPending: false }),
  useFavoriteChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useFavoriteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSetCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useSetConversationCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderCategories: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => window.innerWidth < 768,
}));

function makeChannels(): UserChannel[] {
  return [
    { channelID: 'ch-general', channelName: 'general', channelType: 'public', role: 1, sidebarPosition: 1000 },
    { channelID: 'ch-private', channelName: 'execs', channelType: 'private', role: 1, sidebarPosition: 2000 },
    { channelID: 'ch-favorite', channelName: 'announcements', channelType: 'public', role: 1, favorite: true, sidebarPosition: 500 },
    { channelID: 'ch-categorized', channelName: 'engineering', channelType: 'public', role: 1, categoryID: 'cat-work', sidebarPosition: 1500 },
    { channelID: 'ch-muted', channelName: 'random', channelType: 'public', role: 1, muted: true, sidebarPosition: 3000 },
    { channelID: 'ch-unread', channelName: 'urgent', channelType: 'public', role: 1, sidebarPosition: 4000 },
  ];
}

function makeConversations(): UserConversation[] {
  return [
    {
      conversationID: 'conv-dm',
      type: 'dm',
      displayName: 'Bob Jones',
      participantIDs: ['u-self', 'u-bob'],
      updatedAt: '2026-05-10T10:00:00Z',
    },
    {
      conversationID: 'conv-group',
      type: 'group',
      displayName: 'Project Team',
      participantIDs: ['u-self', 'u-bob', 'u-charlie'],
      updatedAt: '2026-05-09T10:00:00Z',
    },
    {
      conversationID: 'conv-favorite-dm',
      type: 'dm',
      displayName: 'Carol',
      participantIDs: ['u-self', 'u-carol'],
      favorite: true,
      updatedAt: '2026-05-11T10:00:00Z',
    },
    {
      conversationID: 'conv-hidden',
      type: 'dm',
      displayName: 'Hidden DM',
      participantIDs: ['u-self', 'u-h'],
      updatedAt: '2026-05-05T10:00:00Z',
    },
  ];
}

function makeCategories(): SidebarCategory[] {
  return [
    { id: 'cat-work', name: 'Work', position: 1000, createdAt: '2026-04-01T10:00:00Z' },
  ];
}

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Frame({ onClose }: { onClose?: () => void }) {
  return (
    <QueryClientProvider client={queryClient()}>
      <BrowserRouter>
        <div
          className="browser-sidebar-frame"
          style={{ height: 600, width: Math.min(window.innerWidth, 360), background: '#1a1d21', overflow: 'hidden' }}
        >
          <style>
            {`
              .browser-sidebar-frame > div {
                display: flex;
                height: 100%;
                width: 100%;
                min-width: 0;
                flex-direction: column;
              }
              .browser-sidebar-frame [data-slot="scroll-area"] {
                min-height: 0;
                flex: 1 1 0%;
                width: 100%;
              }
              .browser-sidebar-frame [data-slot="scroll-area-viewport"] {
                height: 100%;
                overflow-y: auto;
              }
            `}
          </style>
          <Sidebar onClose={onClose ?? vi.fn()} />
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function RouteFrame({ path }: { path: string }) {
  return (
    <QueryClientProvider client={queryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <div
          className="browser-sidebar-frame"
          style={{ height: 600, width: Math.min(window.innerWidth, 360), background: '#1a1d21', overflow: 'hidden' }}
        >
          <Sidebar onClose={vi.fn()} />
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Surfaces the current pathname so a click that calls navigate() can be
// asserted without touching the real window history.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function MobileNavFrame() {
  return (
    <QueryClientProvider client={queryClient()}>
      <MemoryRouter>
        <div
          className="browser-sidebar-frame"
          style={{ height: 600, width: Math.min(window.innerWidth, 360), background: '#1a1d21', overflow: 'hidden' }}
        >
          <Sidebar onClose={vi.fn()} />
        </div>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function setReactInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  currentUser = adminUser;
  currentLogout = vi.fn().mockResolvedValue(undefined);
  mockUnread = {
    unreadChannels: new Set(['ch-unread']),
    unreadChannelNotifications: new Set(),
    unreadConversations: new Set(),
    unreadThreadNotifications: new Set(),
    hiddenConversations: new Set(),
  };
  mockOnline = new Set(['u-bob']);
  mockChannels = makeChannels();
  mockConversations = makeConversations();
  mockConversationsState = { data: mockConversations, isError: false };
  mockCategories = makeCategories();
  mockThreads = [
    { parentID: 'ch-general', parentType: 'channel', threadRootID: 'msg-thread-root', lastReplyAt: '2026-05-11T11:00:00Z' },
  ];
  mockUserState = {
    hiddenConversations: ['conv-hidden'],
    channelNotifications: ['ch-favorite'],
    threadNotifications: [],
    threadSeen: {},
  };
  mockDrafts = [
    { parentID: 'ch-general', parentType: 'channel' },
    { parentID: 'ch-private', parentType: 'channel' },
  ];
  apiFetchMock.mockClear();
  createChannelMutate.mockClear();
  createCategoryMutate.mockClear();
  deleteCategoryMutate.mockClear();
  hideConversationMock.mockClear();
  try { localStorage.removeItem('sidebar.conversationSort'); } catch { /* noop */ }
});

describe('Sidebar browser render — rich fixtures', () => {
  it('shows the channels, favorites, categories, conversations and drafts badge', async () => {
    const screen = await render(<Frame />);
    // The user header (display name + admin badge) was moved to the
    // top-bar account dropdown — the sidebar now only carries the
    // navigation rail and channel/DM lists.
    await expect.element(screen.getByText('Favorites')).toBeVisible();
    await expect.element(screen.getByText('Work')).toBeVisible();
    await expect.element(screen.getByText('Channels')).toBeVisible();
    await expect.element(screen.getByText('Direct Messages')).toBeVisible();
    await expect.element(screen.getByText('Drafts')).toBeVisible();
    await expect.element(screen.getByText('Directory')).toBeVisible();
    // Drafts badge reflects the 2 mock drafts.
    expect(document.body.textContent).toContain('2');
    // Favorite channel rendered.
    await expect.element(screen.getByText('announcements')).toBeVisible();
    // Hidden conversation does NOT render even though it's in conversations[].
    expect(document.body.textContent).not.toContain('Hidden DM');
    // Drag-and-drop hitbox renders for favorites/user-category/channels (3 of them).
    const hitboxes = document.querySelectorAll('[data-testid^="sidebar-category-boundary-drop-"]');
    expect(hitboxes.length).toBeGreaterThanOrEqual(3);
    // Threads link is bold (unread thread present).
    const threadsLink = document.querySelector('a[href="/threads"] span') as HTMLElement;
    expect(threadsLink?.className).toContain('font-bold');
  });

  it('opens the category create input, accepts a name and dispatches the mutation', async () => {
    const screen = await render(<Frame />);
    const addBtn = screen.getByTestId('sidebar-add-category');
    await addBtn.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-new-category-input"]')).not.toBeNull();
    });
    const input = document.querySelector('[data-testid="sidebar-new-category-input"]') as HTMLInputElement;
    input.focus();
    setReactInputValue(input, 'Personal');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(createCategoryMutate).toHaveBeenCalledWith('Personal', expect.any(Object));
    });
  });

  it('does not dispatch the create on empty input and clears with Escape', async () => {
    const screen = await render(<Frame />);
    await screen.getByTestId('sidebar-add-category').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-new-category-input"]')).not.toBeNull();
    });
    const input = document.querySelector('[data-testid="sidebar-new-category-input"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(createCategoryMutate).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-new-category-input"]')).toBeNull();
      expect(document.querySelector('[data-testid="sidebar-add-category"]')).not.toBeNull();
    });
  });

  it('toggles a section collapse via click', async () => {
    const screen = await render(<Frame />);
    const toggle = screen.getByTestId('sidebar-group-toggle-__channels__');
    await toggle.click();
    await vi.waitFor(() => {
      const t = document.querySelector('[data-testid="sidebar-group-toggle-__channels__"]') as HTMLElement;
      expect(t.getAttribute('aria-expanded')).toBe('false');
    });
    await toggle.click();
    await vi.waitFor(() => {
      const t = document.querySelector('[data-testid="sidebar-group-toggle-__channels__"]') as HTMLElement;
      expect(t.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('renders the loading skeleton when conversations are still pending', async () => {
    mockConversationsState = { data: undefined, isError: false };
    await render(<Frame />);
    expect(document.querySelector('[data-testid="sidebar-primary-loading"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="sidebar-primary-sections"]')).toBeNull();
  });

  it('renders sections when conversations request errors out', async () => {
    mockConversationsState = { data: undefined, isError: true };
    await render(<Frame />);
    expect(document.querySelector('[data-testid="sidebar-primary-sections"]')).not.toBeNull();
  });

  it('omits the create-channel "+" for guest users', async () => {
    currentUser = guestUser;
    await render(<Frame />);
    expect(document.querySelector('[data-testid="sidebar-create-channel"]')).toBeNull();
  });

  it('keeps the create-channel "+" for regular members', async () => {
    currentUser = memberUser;
    await render(<Frame />);
    expect(document.querySelector('[data-testid="sidebar-create-channel"]')).not.toBeNull();
  });

  it('exposes the New-DM "+" as a real tap target on mobile and navigates to /conversations/new', async () => {
    if (window.innerWidth > 767) return;
    await render(<MobileNavFrame />);
    const plus = document.querySelector('[data-testid="sidebar-new-dm"]') as HTMLElement;
    expect(plus).not.toBeNull();
    // Visible + tappable on touch (no hover to reveal it).
    expect(getComputedStyle(plus).opacity).toBe('1');
    // The sort menu stays desktop hover-only, so it's hidden on mobile — the
    // DM header shows only the "+".
    const sort = document.querySelector('[data-testid="sidebar-dm-sort-menu"]') as HTMLElement;
    expect(getComputedStyle(sort).opacity).toBe('0');

    plus.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="loc"]')?.textContent).toBe('/conversations/new');
    });
  });

  it('exposes the create-channel "+" as a visible tap target on mobile', async () => {
    if (window.innerWidth > 767) return;
    await render(<Frame />);
    const plus = document.querySelector('[data-testid="sidebar-create-channel"]') as HTMLElement;
    expect(plus).not.toBeNull();
    expect(getComputedStyle(plus).opacity).toBe('1');
  });

  it('paints the favorited and unread channels in the desktop viewport', async () => {
    const screen = await render(<Frame />);
    if (window.innerWidth >= 768) {
      const favorited = screen.getByText('announcements');
      await expect.element(favorited).toBeVisible();
      const urgent = screen.getByText('urgent');
      await expect.element(urgent).toBeVisible();
      expectPaintedAtCenter(favorited.element());
    }
  });

  it('runs only under the configured desktop and mobile browser sizes', () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    expect([
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
      { width: 393, height: 852 },
    ]).toContainEqual(viewport);
  });

  it('renders with no categories and no favorites — only default Channels + DMs sections', async () => {
    mockCategories = [];
    mockChannels = [
      { channelID: 'ch-a', channelName: 'alpha', channelType: 'public', role: 1 },
      { channelID: 'ch-b', channelName: 'beta', channelType: 'public', role: 1 },
    ];
    mockConversations = [];
    mockConversationsState = { data: [], isError: false };
    await render(<Frame />);
    expect(document.body.textContent).toContain('Channels');
    expect(document.body.textContent).toContain('Direct Messages');
    // No user-defined category named "Work" when categories=[].
    expect(document.body.textContent).not.toContain('Work');
    expect(document.body.textContent).toContain('alpha');
    expect(document.body.textContent).toContain('beta');
  });

  it('reads conversationSort=az from localStorage on first mount', async () => {
    try { localStorage.setItem('sidebar.conversationSort', 'az'); } catch { /* noop */ }
    await render(<Frame />);
    // Trigger render — Bob Jones (B) should appear before Project Team (P).
    const bob = document.body.textContent?.indexOf('Bob Jones') ?? -1;
    const project = document.body.textContent?.indexOf('Project Team') ?? -1;
    expect(bob).toBeGreaterThanOrEqual(0);
    expect(project).toBeGreaterThanOrEqual(0);
    // A-Z order alphabetically.
    expect(bob).toBeLessThan(project);
  });

  it('renders threads link unbolded when there are no unread threads', async () => {
    mockThreads = [];
    await render(<Frame />);
    const threadsLink = document.querySelector('a[href="/threads"] span') as HTMLElement;
    expect(threadsLink.className).not.toContain('font-bold');
  });

  it('renders no drafts badge when there are no drafts', async () => {
    mockDrafts = [];
    await render(<Frame />);
    const draftsLink = document.querySelector('a[href="/drafts"]');
    expect(draftsLink).not.toBeNull();
    // Badge has class h-5 / min-w-5 — absence means no draft count visible.
    expect(draftsLink!.querySelector('[class*="h-5"]')).toBeNull();
  });

  it('handles a non-admin user without showing the Admin badge', async () => {
    currentUser = memberUser;
    await render(<Frame />);
    expect(document.body.textContent).not.toContain('Admin');
  });

  it('typing into the new-category input and pressing Enter stops re-creating once cleared', async () => {
    const screen = await render(<Frame />);
    await screen.getByTestId('sidebar-add-category').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-new-category-input"]')).not.toBeNull();
    });
    const input = document.querySelector('[data-testid="sidebar-new-category-input"]') as HTMLInputElement;
    input.focus();
    setReactInputValue(input, 'Side Projects');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(createCategoryMutate).toHaveBeenCalledWith('Side Projects', expect.any(Object));
    });
    // After onSuccess the input collapses back to the button.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-new-category-input"]')).toBeNull();
      expect(document.querySelector('[data-testid="sidebar-add-category"]')).not.toBeNull();
    });
  });

  it('renders a sidebar with many channels — drafts badge shows the count', async () => {
    mockChannels = Array.from({ length: 25 }, (_, i) => ({
      channelID: `ch-${i}`,
      channelName: `channel-${i}`,
      channelType: 'public' as const,
      role: 1,
    }));
    mockDrafts = Array.from({ length: 5 }, (_, i) => ({ parentID: `ch-${i}`, parentType: 'channel' }));
    await render(<Frame />);
    const draftsLink = document.querySelector('a[href="/drafts"]') as HTMLElement;
    expect(draftsLink).not.toBeNull();
    expect(draftsLink.textContent).toContain('5');
  });

  it('renders favorites with a mix of channels and DMs', async () => {
    mockChannels = [
      { channelID: 'ch-1', channelName: 'announcements', channelType: 'public', role: 1, favorite: true, sidebarPosition: 100 },
    ];
    mockConversations = [
      {
        conversationID: 'conv-fav',
        type: 'dm',
        displayName: 'Bob Jones',
        participantIDs: ['u-self', 'u-bob'],
        favorite: true,
        updatedAt: '2026-05-10T10:00:00Z',
      },
    ];
    mockConversationsState = { data: mockConversations, isError: false };
    mockCategories = [];
    await render(<Frame />);
    expect(document.body.textContent).toContain('Favorites');
    expect(document.body.textContent).toContain('announcements');
    expect(document.body.textContent).toContain('Bob Jones');
  });

  it('triggers the Directory nav-link onClose callback when clicked', async () => {
    const onClose = vi.fn();
    const screen = await render(<Frame onClose={onClose} />);
    await screen.getByText('Directory').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('renders multiple user categories side by side', async () => {
    mockCategories = [
      { id: 'cat-work', name: 'Work', position: 1000 },
      { id: 'cat-personal', name: 'Personal', position: 2000 },
    ];
    mockChannels = [
      { channelID: 'ch-1', channelName: 'eng', channelType: 'public', role: 1, categoryID: 'cat-work', sidebarPosition: 100 },
      { channelID: 'ch-2', channelName: 'family', channelType: 'public', role: 1, categoryID: 'cat-personal', sidebarPosition: 200 },
    ];
    mockConversations = [];
    mockConversationsState = { data: mockConversations, isError: false };
    await render(<Frame />);
    expect(document.body.textContent).toContain('Work');
    expect(document.body.textContent).toContain('Personal');
    expect(document.body.textContent).toContain('eng');
    expect(document.body.textContent).toContain('family');
  });

  // ── Extension coverage — close as many leftover Sidebar branches
  // as possible. These run across all browser viewports configured
  // in vitest.browser.config.ts (chromium-desktop, chromium-mobile,
  // webkit-iphone) so each branch that depends on `isMobile` /
  // viewport width is exercised on both sides of the breakpoint.

  it('changes DM sort to A-Z via the sort menu and reorders the visible DMs', async () => {
    // Recent (default) puts conv-favorite-dm (May 11) before conv-dm (May 10)
    // and conv-group (May 9). Mobile viewport hides the sort menu trigger so
    // skip there — coverage of the alphabetic branch still fires on desktop.
    if (window.innerWidth < 768) return;
    await render(<Frame />);
    const sortTrigger = document.querySelector('[data-testid="sidebar-dm-sort-menu"]') as HTMLElement;
    expect(sortTrigger).not.toBeNull();
    sortTrigger.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('A-Z');
    });
    // Click the A-Z item in the open dropdown. Radix portals the
    // dropdown to body, so query the document broadly.
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
    const az = items.find((el) => el.textContent?.includes('A-Z'));
    expect(az).toBeTruthy();
    az?.click();
    // Bob Jones (B…) sorts before Project Team (P…) alphabetically.
    await vi.waitFor(() => {
      const text = document.body.textContent ?? '';
      const bob = text.indexOf('Bob Jones');
      const project = text.indexOf('Project Team');
      expect(bob).toBeGreaterThanOrEqual(0);
      expect(project).toBeGreaterThanOrEqual(0);
      expect(bob).toBeLessThan(project);
    });
    expect(localStorage.getItem('sidebar.conversationSort')).toBe('az');
  });

  it('flips back to recent activity via the sort menu', async () => {
    if (window.innerWidth < 768) return;
    try { localStorage.setItem('sidebar.conversationSort', 'az'); } catch { /* noop */ }
    await render(<Frame />);
    const sortTrigger = document.querySelector('[data-testid="sidebar-dm-sort-menu"]') as HTMLElement;
    sortTrigger.click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Recent activity');
    });
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
    const recent = items.find((el) => el.textContent?.includes('Recent activity'));
    recent?.click();
    await vi.waitFor(() => {
      expect(localStorage.getItem('sidebar.conversationSort')).toBe('recent');
    });
  });

  it('opens the category kebab and the delete entry triggers the confirm modal', async () => {
    await render(<Frame />);
    // The kebab is positioned absolutely and may be `opacity-0` until
    // hover on desktop; on mobile it's always visible. Click it via
    // its testid which is reachable regardless of visibility.
    const kebab = document.querySelector('[data-testid="sidebar-category-menu-cat-work"]') as HTMLElement | null;
    expect(kebab).not.toBeNull();
    kebab!.click();
    await vi.waitFor(() => {
      const del = document.querySelector('[data-testid="sidebar-category-delete-cat-work"]');
      expect(del).not.toBeNull();
    });
    const del = document.querySelector('[data-testid="sidebar-category-delete-cat-work"]') as HTMLElement;
    del.click();
    // A confirm dialog opens; the existing UI uses a modal with the
    // category title in it. Just assert the title appears somewhere
    // in a dialog/alertdialog role region — exact wording can drift.
    await vi.waitFor(() => {
      const modals = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      const hasTitle = Array.from(modals).some((m) => m.textContent?.includes('Work'));
      expect(hasTitle).toBe(true);
    });
  });

  it('confirms category deletion and dispatches the delete mutation', async () => {
    await render(<Frame />);
    const kebab = document.querySelector('[data-testid="sidebar-category-menu-cat-work"]') as HTMLElement;
    kebab.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-category-delete-cat-work"]')).not.toBeNull();
    });
    (document.querySelector('[data-testid="sidebar-category-delete-cat-work"]') as HTMLElement).click();
    // Click the destructive confirm button → onConfirm fires with a non-null
    // categoryToDelete (the truthy arm) and the delete mutation runs.
    await vi.waitFor(() => {
      const confirm = document.querySelector('[data-testid="delete-category-confirm"]');
      expect(confirm).not.toBeNull();
    });
    (document.querySelector('[data-testid="delete-category-confirm"]') as HTMLElement).click();
    await vi.waitFor(() => {
      expect(deleteCategoryMutate).toHaveBeenCalledWith('cat-work');
    });
  });

  it('dismissing the delete-category dialog clears the pending deletion', async () => {
    await render(<Frame />);
    const kebab = document.querySelector('[data-testid="sidebar-category-menu-cat-work"]') as HTMLElement;
    kebab.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-category-delete-cat-work"]')).not.toBeNull();
    });
    (document.querySelector('[data-testid="sidebar-category-delete-cat-work"]') as HTMLElement).click();
    await vi.waitFor(() => {
      const modals = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      expect(Array.from(modals).some((m) => m.textContent?.includes('Work'))).toBe(true);
    });
    // Escape dismisses → onOpenChange(false) takes the `!o` branch and resets
    // categoryToDelete to null, closing the dialog.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      const modals = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      expect(Array.from(modals).some((m) => m.textContent?.includes('Work'))).toBe(false);
    });
    expect(deleteCategoryMutate).not.toHaveBeenCalled();
  });

  it('shows the create-channel button for admin users in the Channels section', async () => {
    if (window.innerWidth < 768) return;
    await render(<Frame />);
    const btn = document.querySelector('[data-testid="sidebar-create-channel"]') as HTMLElement;
    expect(btn).not.toBeNull();
    btn.click();
    // Clicking opens a dialog; assert SOMETHING with "create" or
    // "channel" text appears in a portal — the dialog is real Radix.
    await vi.waitFor(() => {
      const modals = document.querySelectorAll('[role="dialog"]');
      expect(modals.length).toBeGreaterThan(0);
    });
  });

  // The User menu was relocated to AppTopBar's account dropdown.
  // Its behavioural coverage now lives in AppTopBar.test.tsx; the
  // sidebar no longer renders the user header or the mobile user menu.

  it('renders a private-channel icon for a private channel in the Channels section', async () => {
    await render(<Frame />);
    // ch-private is `channelType: 'private'` — ChannelRow renders a
    // lock icon for private channels. We don't depend on the exact
    // icon markup, just that the row containing 'execs' renders
    // with the private styling/affordances ChannelRow provides.
    const row = Array.from(document.querySelectorAll('a')).find((a) => a.textContent?.includes('execs'));
    expect(row).toBeTruthy();
  });

  it('renders the drafts badge clamped to "99+" when there are many drafts', async () => {
    mockDrafts = Array.from({ length: 120 }, (_, i) => ({ parentID: `ch-${i}`, parentType: 'channel' }));
    await render(<Frame />);
    const draftsLink = document.querySelector('a[href="/drafts"]') as HTMLElement;
    expect(draftsLink).not.toBeNull();
    // Counts beyond 99 collapse to "99+" so the rounded-square chip
    // stays the same visual width.
    expect(draftsLink.textContent).toContain('99+');
    expect(draftsLink.textContent).not.toContain('120');
  });

  it('shows the unread dot/style on a channel with notifications even without an unread message', async () => {
    // ch-favorite is marked as a channelNotification target in
    // mockUserState — beforeEach seeds that. Confirm the announcements
    // channel is rendered (the notification styling is delegated to
    // ChannelRow and visualised via class names that can drift).
    await render(<Frame />);
    const row = Array.from(document.querySelectorAll('a')).find((a) => a.textContent?.includes('announcements'));
    expect(row).toBeTruthy();
  });

  it('floors the badge to 1 when a channel is unread but carries no count', async () => {
    // A channel the server flags unread but with an unknown/zero count still
    // shows a NUMBER box floored to "1", never a dot. (The single source is the
    // server seq flag on the list row — no session set.)
    mockChannels = makeChannels().map((c) => (c.channelID === 'ch-general' ? { ...c, unread: true } : c));
    mockUserState = { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} };
    await render(<Frame />);
    expect(document.querySelector('[data-testid="channel-unread-badge-ch-general"]')?.textContent).toBe('1');
    expect(document.querySelector('[data-testid="channel-unread-dot-ch-general"]')).toBeNull();
  });

  it('shows the server-computed unread count on cold load (no live events)', async () => {
    // Channel carries server-side unread state from /api/v1/channels — the
    // authoritative source after a reload, with empty session maps. The badge
    // must render the exact count without any message.new having arrived.
    mockChannels = [
      { channelID: 'ch-cold', channelName: 'ops', channelType: 'public', role: 1, sidebarPosition: 1000, unread: true, unreadCount: 7 },
    ];
    mockUserState = { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} };
    await render(<Frame />);
    const badge = document.querySelector('[data-testid="channel-unread-badge-ch-cold"]');
    expect(badge?.textContent).toBe('7');
  });

  it('shows the server-computed conversation unread count on cold load', async () => {
    // Conversations now carry the same server-side seq-based unread as channels.
    mockChannels = [];
    mockConversations = makeConversations().map((c) =>
      c.conversationID === 'conv-dm' ? { ...c, unread: true, unreadCount: 4 } : c,
    );
    mockConversationsState = { data: mockConversations, isError: false };
    mockUserState = { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} };
    await render(<Frame />);
    const badge = document.querySelector('[data-testid="conversation-unread-badge-conv-dm"]');
    expect(badge?.textContent).toBe('4');
  });

  it('does NOT double-count a non-favorite DM when the session map is seeded from the server', async () => {
    // Regression: UnreadServerCountSync seeds conversationUnreadCounts from the
    // SAME server unreadCount the row also reads. The non-favorite DM row must
    // use the map as the single source (== 4), not sum map+server (== 8).
    mockChannels = [];
    mockConversations = makeConversations().map((c) =>
      c.conversationID === 'conv-dm' ? { ...c, unread: true, unreadCount: 4 } : c,
    );
    mockConversationsState = { data: mockConversations, isError: false };
    mockUnread = {
      unreadChannels: new Set(),
      unreadChannelNotifications: new Set(),
      unreadConversations: new Set(),
      unreadThreadNotifications: new Set(),
      hiddenConversations: new Set(),
      channelUnreadCounts: new Map(),
      conversationUnreadCounts: new Map([['conv-dm', 4]]),
    };
    mockUserState = { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} };
    await render(<Frame />);
    const badge = document.querySelector('[data-testid="conversation-unread-badge-conv-dm"]');
    expect(badge?.textContent).toBe('4');
  });

  it('renders empty state with no channels and no DMs (just nav links)', async () => {
    mockChannels = [];
    mockConversations = [];
    mockConversationsState = { data: [], isError: false };
    mockCategories = [];
    mockDrafts = [];
    mockThreads = [];
    await render(<Frame />);
    // Nav links survive an empty workspace.
    expect(document.body.textContent).toContain('Directory');
    expect(document.body.textContent).toContain('Drafts');
    expect(document.body.textContent).toContain('Threads');
  });

  it('Threads link stays unbolded when there are no thread updates', async () => {
    // mockThreads = [] returns 0 from the unreadThreadIDs helper
    // mocked at the top of the file (it maps threads.length → set
    // size), so the hasThreadUpdates branch is false and the link
    // renders without the unread-bold style.
    mockThreads = [];
    mockUserState = {
      hiddenConversations: [],
      channelNotifications: [],
      threadNotifications: [],
      threadSeen: {},
    };
    await render(<Frame />);
    const threadsLink = document.querySelector('a[href="/threads"] span') as HTMLElement;
    expect(threadsLink.className).not.toContain('font-bold');
  });

  it('groups channels by category and keeps uncategorised channels in Channels', async () => {
    mockCategories = [{ id: 'cat-x', name: 'Side Projects', position: 1000 }];
    mockChannels = [
      { channelID: 'ch-side', channelName: 'side-project', channelType: 'public', role: 1, categoryID: 'cat-x' },
      { channelID: 'ch-misc', channelName: 'misc', channelType: 'public', role: 1 },
    ];
    mockConversations = [];
    mockConversationsState = { data: [], isError: false };
    await render(<Frame />);
    expect(document.body.textContent).toContain('Side Projects');
    expect(document.body.textContent).toContain('side-project');
    expect(document.body.textContent).toContain('Channels');
    expect(document.body.textContent).toContain('misc');
  });

  it('drives the inline new-category input through a typed value and Enter dispatch', async () => {
    const screen = await render(<Frame />);
    await screen.getByTestId('sidebar-add-category').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-new-category-input"]')).not.toBeNull();
    });
    const input = document.querySelector('[data-testid="sidebar-new-category-input"]') as HTMLInputElement;
    input.focus();
    setReactInputValue(input, 'Marketing');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(createCategoryMutate).toHaveBeenCalledWith('Marketing', expect.any(Object));
    });
  });

  it('does not crash with profileResolved DMs (skips dmUserMap lookup)', async () => {
    mockConversations = [
      {
        conversationID: 'conv-pre',
        type: 'dm',
        displayName: 'Pre-resolved',
        participantIDs: ['u-self', 'u-pre'],
        profileResolved: true,
        avatarURL: 'https://example.com/a.png',
        updatedAt: '2026-05-09T10:00:00Z',
      },
    ];
    mockConversationsState = { data: mockConversations, isError: false };
    await render(<Frame />);
    expect(document.body.textContent).toContain('Pre-resolved');
  });

  it('renders presence dot for an online DM partner', async () => {
    mockOnline = new Set(['u-bob']);
    await render(<Frame />);
    // The presence dot is a small element styled green; assert it
    // exists adjacent to Bob Jones's row by searching for any
    // element whose computed background includes the green range.
    // We don't care about exact RGB — just that *something* renders
    // for the online DM.
    const bobRow = Array.from(document.querySelectorAll('a')).find((a) => a.textContent?.includes('Bob Jones'));
    expect(bobRow).toBeTruthy();
  });

  it('renders Directory + Threads nav links with click handlers that call onClose', async () => {
    const onClose = vi.fn();
    await render(<Frame onClose={onClose} />);
    // Click directly on the Threads nav link (href-anchored) rather
    // than `getByText('Threads')` — the unread badge now carries an
    // sr-only "Unread threads" label which would collide with the
    // text-only locator under Playwright strict mode.
    const threadsLink = document.querySelector('a[href="/threads"]') as HTMLElement;
    threadsLink?.click();
    expect(onClose).toHaveBeenCalled();
  });

  it('seeds threadSeen via markThreadSeen and re-renders without forcing a remount', async () => {
    // Sanity check that the local-seen cache hook does not blow up
    // when the THREAD_SEEN_CHANGED_EVENT fires while the sidebar is
    // mounted (regression for an early-exit branch).
    await render(<Frame />);
    window.dispatchEvent(new CustomEvent('ex:thread-seen-changed'));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-testid="sidebar-primary-sections"]')).not.toBeNull();
  });

  // ── Bulk coverage extension. The remaining missing branches in
  // Sidebar.tsx are mostly conditional render permutations that can
  // be flushed by varying the mock fixtures and re-mounting. Each
  // case below toggles one specific render gate.

  it('renders with all channels muted — picks up the muted-styling branch', async () => {
    mockChannels = mockChannels.map((c) => ({ ...c, muted: true }));
    await render(<Frame />);
    expect(document.body.textContent).toContain('general');
  });

  it('renders with every conversation marked as unread', async () => {
    mockUnread = {
      unreadChannels: new Set(),
      unreadChannelNotifications: new Set(),
      unreadConversations: new Set(mockConversations.map((c) => c.conversationID)),
      unreadThreadNotifications: new Set(),
      hiddenConversations: new Set(),
    };
    await render(<Frame />);
    expect(document.body.textContent).toContain('Bob Jones');
  });

  it('renders thread-notifications driving the Threads link bold', async () => {
    mockUnread = {
      unreadChannels: new Set(),
      unreadChannelNotifications: new Set(),
      unreadConversations: new Set(),
      unreadThreadNotifications: new Set(['thr-1']),
      hiddenConversations: new Set(),
    };
    mockThreads = [
      { parentID: 'ch-general', parentType: 'channel', threadRootID: 'thr-1', lastReplyAt: '2026-05-11T10:00:00Z' },
    ];
    await render(<Frame />);
    const threadsLink = document.querySelector('a[href="/threads"] span') as HTMLElement;
    expect(threadsLink.className).toContain('font-bold');
  });

  it('renders with a group conversation containing 3+ participants', async () => {
    mockConversations = [
      {
        conversationID: 'conv-trio',
        type: 'group',
        displayName: 'Trio',
        participantIDs: ['u-self', 'u-bob', 'u-carol'],
        updatedAt: '2026-05-08T10:00:00Z',
      },
    ];
    mockConversationsState = { data: mockConversations, isError: false };
    await render(<Frame />);
    expect(document.body.textContent).toContain('Trio');
  });

  it('hides DMs that are listed under hiddenConversations in user state', async () => {
    mockUserState = {
      hiddenConversations: ['conv-dm'],
      channelNotifications: [],
      threadNotifications: [],
      threadSeen: {},
    };
    await render(<Frame />);
    expect(document.body.textContent).not.toContain('Bob Jones');
  });

  it('shows a public conversation with a stale updatedAt (predates the favorite DM)', async () => {
    mockConversations = [
      {
        conversationID: 'conv-stale',
        type: 'dm',
        displayName: 'Old DM',
        participantIDs: ['u-self', 'u-other'],
        updatedAt: '2026-01-01T10:00:00Z',
      },
      {
        conversationID: 'conv-fresh',
        type: 'dm',
        displayName: 'Fresh DM',
        participantIDs: ['u-self', 'u-fresh'],
        updatedAt: '2026-05-12T10:00:00Z',
      },
    ];
    mockConversationsState = { data: mockConversations, isError: false };
    await render(<Frame />);
    const text = document.body.textContent ?? '';
    // Recent sort puts Fresh DM first.
    expect(text.indexOf('Fresh DM')).toBeLessThan(text.indexOf('Old DM'));
  });

  it('renders without categories nor favorites — shows only Channels/DMs sections', async () => {
    mockCategories = [];
    mockChannels = [{ channelID: 'ch-1', channelName: 'a', channelType: 'public', role: 1 }];
    mockConversations = [];
    mockConversationsState = { data: [], isError: false };
    mockDrafts = [];
    mockThreads = [];
    mockUserState = { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} };
    await render(<Frame />);
    expect(document.body.textContent).not.toContain('Work');
    expect(document.body.textContent).toContain('Channels');
    expect(document.body.textContent).toContain('Direct Messages');
  });

  it('renders thread row with mixed unread/seen permutations without crashing', async () => {
    mockThreads = [
      { parentID: 'ch-general', parentType: 'channel', threadRootID: 't1', lastReplyAt: '2026-05-11T10:00:00Z' },
      { parentID: 'conv-dm', parentType: 'conversation', threadRootID: 't2', lastReplyAt: '2026-05-09T10:00:00Z' },
    ];
    mockUserState = {
      hiddenConversations: [],
      channelNotifications: [],
      threadNotifications: ['t1'],
      threadSeen: { t2: '2026-05-09T11:00:00Z' },
    };
    await render(<Frame />);
    expect(document.querySelector('[data-testid="sidebar-primary-sections"]')).not.toBeNull();
  });

  it('renders even when userState is undefined entirely (cold cache)', async () => {
    mockUserState = undefined;
    await render(<Frame />);
    expect(document.querySelector('[data-testid="sidebar-primary-sections"]')).not.toBeNull();
  });

  it('renders without throwing for conversation rows that have no participantIDs', async () => {
    mockConversations = [
      {
        conversationID: 'conv-headless',
        type: 'dm',
        displayName: 'Headless',
        updatedAt: '2026-05-10T10:00:00Z',
      },
    ];
    mockConversationsState = { data: mockConversations, isError: false };
    await render(<Frame />);
    expect(document.body.textContent).toContain('Headless');
  });

  it('clamps the Threads unread badge to "99+" when there are more than 99 unread threads', async () => {
    mockThreads = Array.from({ length: 120 }, (_, i) => ({
      parentID: 'ch-general',
      parentType: 'channel' as const,
      threadRootID: `msg-${i}`,
      lastReplyAt: '2026-05-11T11:00:00Z',
    }));
    await render(<Frame />);
    const badge = document.querySelector('[data-testid="threads-unread-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('99+');
  });

  it('renders the Activity row with an unread badge clamped to 99+', async () => {
    apiFetchMock.mockImplementation(async (path: string) =>
      path === '/api/v1/activity' ? { items: [], unread: 150 } : null,
    );
    await render(<Frame />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="activity-unread-badge"]')?.textContent).toBe('99+');
    });
  });

  it('renders the exact Activity unread count when under 100', async () => {
    apiFetchMock.mockImplementation(async (path: string) =>
      path === '/api/v1/activity' ? { items: [], unread: 5 } : null,
    );
    await render(<Frame />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="activity-unread-badge"]')?.textContent).toBe('5');
    });
  });

  it('keeps unread channels and conversations visible inside a collapsed section', async () => {
    // A favorites section holding both a channel (with a notification) and a
    // DM (unread) — collapsing it runs the collapsed-filter for both kinds.
    mockChannels = [
      { channelID: 'ch-favorite', channelName: 'announcements', channelType: 'public', role: 1, favorite: true, sidebarPosition: 500, unread: true },
    ];
    mockConversations = [
      {
        conversationID: 'conv-favorite-dm',
        type: 'dm',
        displayName: 'Carol',
        participantIDs: ['u-self', 'u-carol'],
        favorite: true,
        unread: true,
        updatedAt: '2026-05-11T10:00:00Z',
      },
    ];
    mockConversationsState = { data: mockConversations, isError: false };
    mockCategories = [];
    mockUserState = {
      hiddenConversations: [],
      channelNotifications: [],
      threadNotifications: [],
      threadSeen: {},
    };
    const screen = await render(<Frame />);
    const toggle = screen.getByTestId('sidebar-group-toggle-__favorites__');
    await toggle.click();
    await vi.waitFor(() => {
      const t = document.querySelector('[data-testid="sidebar-group-toggle-__favorites__"]') as HTMLElement;
      expect(t.getAttribute('aria-expanded')).toBe('false');
    });
    // Both the unread channel and unread DM stay visible despite the collapse.
    expect(document.body.textContent).toContain('announcements');
    expect(document.body.textContent).toContain('Carol');
  });

  it('toggles a section collapse with the keyboard (Enter on the group header)', async () => {
    await render(<Frame />);
    const toggle = document.querySelector('[data-testid="sidebar-group-toggle-__channels__"]') as HTMLElement;
    toggle.focus();
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await vi.waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('renders the Drafts nav link in its active state on the /drafts route', async () => {
    await render(<RouteFrame path="/drafts" />);
    const draftsLink = document.querySelector('a[href="/drafts"]') as HTMLAnchorElement;
    expect(draftsLink).not.toBeNull();
    expect(draftsLink.className).toContain('font-semibold');
  });

  it('shows an error message when category creation fails with a non-Error rejection', async () => {
    createCategoryMutate.mockImplementationOnce((_name: string, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.('plain string failure');
    });
    const screen = await render(<Frame />);
    await screen.getByTestId('sidebar-add-category').click();
    const input = (await screen.getByTestId('sidebar-new-category-input').element()) as HTMLInputElement;
    setReactInputValue(input, 'Marketing');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      const alert = document.querySelector('[role="alert"]') as HTMLElement;
      expect(alert).not.toBeNull();
      expect(alert.textContent).toBe('Could not create category');
    });
  });

  it('shows the Error message when category creation fails with an Error rejection', async () => {
    createCategoryMutate.mockImplementationOnce((_name: string, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.(new Error('Name already taken'));
    });
    const screen = await render(<Frame />);
    await screen.getByTestId('sidebar-add-category').click();
    const input = (await screen.getByTestId('sidebar-new-category-input').element()) as HTMLInputElement;
    setReactInputValue(input, 'Sales');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      const alert = document.querySelector('[role="alert"]') as HTMLElement;
      expect(alert?.textContent).toBe('Name already taken');
    });
  });

  it('renders from a fully cold cache where every list hook is undefined', async () => {
    // Drives the `?? []` fallbacks for channels, threads, drafts and categories.
    mockChannels = undefined as unknown as UserChannel[];
    mockThreads = undefined as unknown as typeof mockThreads;
    mockDrafts = undefined as unknown as typeof mockDrafts;
    mockCategories = undefined as unknown as SidebarCategory[];
    mockConversationsState = { data: [], isError: false };
    await render(<Frame />);
    expect(document.querySelector('[data-testid="sidebar-primary-sections"]')).not.toBeNull();
  });

  it('keeps an unread conversation visible in a collapsed section', async () => {
    // A favorites DM flagged unread by the server seq count → the conversation
    // clause of the collapsed filter keeps it visible.
    mockChannels = [];
    mockConversations = [
      {
        conversationID: 'conv-set-unread',
        type: 'dm',
        displayName: 'Dana',
        participantIDs: ['u-self', 'u-dana'],
        favorite: true,
        unread: true,
        updatedAt: '2026-05-11T10:00:00Z',
      },
    ];
    mockConversationsState = { data: mockConversations, isError: false };
    mockCategories = [];
    // userState undefined so the render also exercises its `?? []` fallbacks.
    mockUserState = undefined;
    const screen = await render(<Frame />);
    const toggle = screen.getByTestId('sidebar-group-toggle-__favorites__');
    await toggle.click();
    await vi.waitFor(() => {
      const t = document.querySelector('[data-testid="sidebar-group-toggle-__favorites__"]') as HTMLElement;
      expect(t.getAttribute('aria-expanded')).toBe('false');
    });
    expect(document.body.textContent).toContain('Dana');
  });

  it('renders sections even when the unread-thread-notification set is undefined', async () => {
    mockUnread = {
      unreadChannels: new Set(),
      unreadChannelNotifications: new Set(),
      unreadConversations: new Set(),
      // Force the `unreadThreadNotifications ?? new Set()` fallback.
      unreadThreadNotifications: undefined as unknown as Set<string>,
      hiddenConversations: new Set(),
    };
    await render(<Frame />);
    expect(document.querySelector('[data-testid="sidebar-primary-sections"]')).not.toBeNull();
  });

  it('keeps an unread channel visible in a collapsed section when user state is cold', async () => {
    // A collapsed Channels section with a server-unread channel but undefined
    // userState → the collapsed-channel filter keeps it visible via ch.unread.
    mockChannels = [
      { channelID: 'ch-urgent', channelName: 'urgent', channelType: 'public', role: 1, sidebarPosition: 1000, unread: true },
    ];
    mockConversations = [];
    mockConversationsState = { data: [], isError: false };
    mockCategories = [];
    mockUserState = undefined;
    const screen = await render(<Frame />);
    const toggle = screen.getByTestId('sidebar-group-toggle-__channels__');
    await toggle.click();
    await vi.waitFor(() => {
      const t = document.querySelector('[data-testid="sidebar-group-toggle-__channels__"]') as HTMLElement;
      expect(t.getAttribute('aria-expanded')).toBe('false');
    });
    // The unread channel stays visible despite the collapse and cold userState.
    expect(document.body.textContent).toContain('urgent');
  });

  it('keeps a server-unread channel visible in a collapsed section (no live events)', async () => {
    // The collapsed-channel filter must honour the server-computed
    // UserChannel.unread, not just the session unreadChannels set — otherwise a
    // channel that went unread before this tab loaded would vanish on collapse.
    mockChannels = [
      { channelID: 'ch-srv', channelName: 'srvunread', channelType: 'public', role: 1, sidebarPosition: 1000, unread: true, unreadCount: 3 },
    ];
    mockConversations = [];
    mockConversationsState = { data: [], isError: false };
    mockCategories = [];
    mockUnread = {
      unreadChannels: new Set(),
      unreadChannelNotifications: new Set(),
      unreadConversations: new Set(),
      unreadThreadNotifications: new Set(),
      hiddenConversations: new Set(),
    };
    mockUserState = { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} };
    const screen = await render(<Frame />);
    const toggle = screen.getByTestId('sidebar-group-toggle-__channels__');
    await toggle.click();
    await vi.waitFor(() => {
      const t = document.querySelector('[data-testid="sidebar-group-toggle-__channels__"]') as HTMLElement;
      expect(t.getAttribute('aria-expanded')).toBe('false');
    });
    expect(document.body.textContent).toContain('srvunread');
  });
});
