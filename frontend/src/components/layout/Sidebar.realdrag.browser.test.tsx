import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import type { User, UserChannel, UserConversation, SidebarCategory } from '@/types';

// REAL drag-and-drop coverage for the Sidebar. Unlike Sidebar.drag.browser.test
// (which mocks @atlaskit/pragmatic-drag-and-drop and hand-invokes the monitor
// callbacks), this file uses the REAL library + REAL closest-edge hitbox and
// drives an actual native HTML5 drag with synthetic DragEvents. It therefore
// verifies the wiring the mocked test can't: that the channel rows are really
// registered as draggables, the category header is really a drop target, and a
// genuine drag→drop resolves through the library to the mutation.

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue(null),
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

const adminUser: User = {
  id: 'u-self',
  email: 'alice@test.com',
  displayName: 'Alice Smith',
  systemRole: 'admin',
  status: 'active',
};

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: adminUser,
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    setAuth: vi.fn(),
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set<string>(),
    unreadChannelNotifications: new Set(),
    unreadConversations: new Set<string>(),
    unreadThreadNotifications: new Set<string>(),
    hiddenConversations: new Set<string>(),
    hideConversation: vi.fn(),
    unhideConversation: vi.fn(),
    markChannelUnread: vi.fn(),
    markChannelNotificationUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    markThreadNotificationUnread: vi.fn(),
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    lastSeenByUser: new Map(),
  }),
}));

const setCategoryMutate = vi.fn();

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: makeChannels() }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: makeConversations(), isError: false }),
  useSearchUsers: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useThreads', () => ({
  THREAD_SEEN_CHANGED_EVENT: 'ex:thread-seen-changed',
  getSeenMap: () => ({}),
  unreadThreadIDs: () => new Set<string>(),
  useUserThreads: () => ({ data: [] }),
}));
vi.mock('@/hooks/useUserState', () => ({
  useUserState: () => ({
    data: { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} },
  }),
}));
vi.mock('@/hooks/useDrafts', () => ({ useDrafts: () => ({ data: [] }) }));
vi.mock('@/hooks/useUsersBatch', () => ({ useUsersBatch: () => ({ map: new Map() }) }));
vi.mock('@/hooks/useSidebar', () => ({
  useCategories: () => ({ data: makeCategories() }),
  useCreateCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useFavoriteChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useFavoriteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSetCategory: () => ({ mutate: setCategoryMutate, isPending: false }),
  useSetConversationCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderCategories: () => ({ mutate: vi.fn(), isPending: false }),
}));
// Force desktop so the category drop targets are registered (mobile disables them).
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

function makeChannels(): UserChannel[] {
  return [
    { channelID: 'ch-other', channelName: 'random', channelType: 'public', role: 1, sidebarPosition: 3000 },
    { channelID: 'ch-categorized', channelName: 'engineering', channelType: 'public', role: 1, categoryID: 'cat-work', sidebarPosition: 1500 },
  ];
}
function makeConversations(): UserConversation[] {
  return [];
}
function makeCategories(): SidebarCategory[] {
  return [{ id: 'cat-work', name: 'Work', position: 1000, createdAt: '2026-04-01T10:00:00Z' }];
}

function Frame() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <div style={{ height: 600, width: 360, background: '#1a1d21', overflow: 'hidden' }}>
          <Sidebar onClose={vi.fn()} />
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function fireRealDrag(source: Element, target: Element) {
  const rect = target.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dt = new DataTransfer();
  const ev = (type: string, extra: DragEventInit = {}) =>
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra });

  source.dispatchEvent(ev('dragstart', { button: 0 }));
  await nextFrame();
  target.dispatchEvent(ev('dragenter', { clientX: cx, clientY: cy }));
  target.dispatchEvent(ev('dragover', { clientX: cx, clientY: cy }));
  await nextFrame();
  target.dispatchEvent(ev('drop', { clientX: cx, clientY: cy }));
  source.dispatchEvent(ev('dragend'));
  await nextFrame();
}

beforeEach(() => {
  setCategoryMutate.mockClear();
});

describe('Sidebar real drag-and-drop (no library mock)', () => {
  it('dragging a channel onto a category resolves through the real library to setCategory', async () => {
    await render(<Frame />);
    await nextFrame();

    const source = document.querySelector('[data-testid="channel-row-ch-other"]');
    const target = document.querySelector('[data-testid="sidebar-group-header-cat-work"]');
    expect(source, 'draggable channel row should be in the DOM').toBeTruthy();
    expect(target, 'category drop target should be in the DOM').toBeTruthy();

    await fireRealDrag(source!, target!);

    // The real draggable → real drop-target → real onDrop chain must have fired
    // the move mutation for the channel we actually dragged. This is the wiring
    // the mocked test cannot verify: that the row is genuinely registered as a
    // draggable, the category region is a real drop target, and a native drag
    // resolves through the library to the handler. (The exact destination
    // categoryID is geometry-dependent in a headless layout and is covered
    // exhaustively by the payload-driven branch tests in Sidebar.drag.browser.)
    expect(setCategoryMutate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(setCategoryMutate.mock.calls[0]?.[0])).toContain('ch-other');
  });
});
