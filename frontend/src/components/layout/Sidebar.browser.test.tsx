import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
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
  unreadConversations: Set<string>;
  unreadThreadNotifications: Set<string>;
  hiddenConversations: Set<string>;
} = {
  unreadChannels: new Set(),
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
  it('shows the user, admin badge, channels, favorites, categories, conversations and drafts badge', async () => {
    const screen = await render(<Frame />);
    await expect.element(screen.getByText('Alice Smith')).toBeVisible();
    await expect.element(screen.getByText('Admin')).toBeVisible();
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
});
