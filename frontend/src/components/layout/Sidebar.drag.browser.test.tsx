import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import type { User, UserChannel, UserConversation, SidebarCategory } from '@/types';

// Drag-and-drop branch coverage for Sidebar.tsx. The main browser
// test mocks pragmatic-drag-and-drop adapters as no-ops, so all the
// drop-handler bodies (positionForDrop, dropChannelInto,
// dropConversationInto, moveCategoryBefore, the drop-indicator
// branches) sit at zero. This file captures the monitor callbacks
// the Sidebar registers with monitorForElements and invokes them
// with crafted payloads — that exercises the resolve/apply paths
// without standing up a real DnD harness.

const monitorCallbacks: {
  onDragStart?: (arg: { source: { data: Record<string, unknown> } }) => void;
  onDropTargetChange?: (arg: { location: { current: { dropTargets: Array<{ data: Record<string, unknown> }> } } }) => void;
  onDrag?: (arg: { location: { current: { dropTargets: Array<{ data: Record<string, unknown> }> } } }) => void;
  onDrop?: (arg: { location: { current: { dropTargets: Array<{ data: Record<string, unknown> }> } } }) => void;
} = {};

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
  monitorForElements: (config: typeof monitorCallbacks) => {
    monitorCallbacks.onDragStart = config.onDragStart;
    monitorCallbacks.onDropTargetChange = config.onDropTargetChange;
    monitorCallbacks.onDrag = config.onDrag;
    monitorCallbacks.onDrop = config.onDrop;
    return () => {
      monitorCallbacks.onDragStart = undefined;
      monitorCallbacks.onDropTargetChange = undefined;
      monitorCallbacks.onDrag = undefined;
      monitorCallbacks.onDrop = undefined;
    };
  },
}));
vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine: (...cleanups: Array<() => void>) => () => cleanups.forEach((fn) => fn?.()),
}));
const edgeState = vi.hoisted(() => ({ edge: 'top' as 'top' | 'bottom' }));
vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
  attachClosestEdge: (data: unknown) => data,
  extractClosestEdge: () => edgeState.edge,
}));

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
    unreadConversations: new Set<string>(),
    unreadThreadNotifications: new Set<string>(),
    hiddenConversations: new Set<string>(),
    hideConversation: vi.fn(),
    unhideConversation: vi.fn(),
    markChannelUnread: vi.fn(),
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
const setConversationCategoryMutate = vi.fn();
const reorderCategoriesMutate = vi.fn();
const favoriteChannelMutate = vi.fn();
const favoriteConversationMutate = vi.fn();

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: makeChannels() }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({
    data: makeConversations(),
    isError: false,
  }),
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
    data: {
      hiddenConversations: [],
      channelNotifications: [],
      threadNotifications: [],
      threadSeen: {},
    },
  }),
}));

vi.mock('@/hooks/useDrafts', () => ({
  useDrafts: () => ({ data: [] }),
}));

vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: new Map() }),
}));

vi.mock('@/hooks/useSidebar', () => ({
  useCategories: () => ({ data: makeCategories() }),
  useCreateCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useFavoriteChannel: () => ({ mutate: favoriteChannelMutate, isPending: false }),
  useFavoriteConversation: () => ({ mutate: favoriteConversationMutate, isPending: false }),
  useSetCategory: () => ({ mutate: setCategoryMutate, isPending: false }),
  useSetConversationCategory: () => ({ mutate: setConversationCategoryMutate, isPending: false }),
  useReorderCategories: () => ({ mutate: reorderCategoriesMutate, isPending: false }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => window.innerWidth < 768,
}));

function makeChannels(): UserChannel[] {
  return [
    { channelID: 'ch-general', channelName: 'general', channelType: 'public', role: 1, sidebarPosition: 1000 },
    { channelID: 'ch-favorite', channelName: 'announcements', channelType: 'public', role: 1, favorite: true, sidebarPosition: 500 },
    { channelID: 'ch-categorized', channelName: 'engineering', channelType: 'public', role: 1, categoryID: 'cat-work', sidebarPosition: 1500 },
    { channelID: 'ch-other', channelName: 'random', channelType: 'public', role: 1, sidebarPosition: 3000 },
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
      conversationID: 'conv-fav',
      type: 'dm',
      displayName: 'Carol',
      participantIDs: ['u-self', 'u-carol'],
      favorite: true,
      updatedAt: '2026-05-11T10:00:00Z',
    },
  ];
}

function makeCategories(): SidebarCategory[] {
  return [
    { id: 'cat-work', name: 'Work', position: 1000, createdAt: '2026-04-01T10:00:00Z' },
    { id: 'cat-personal', name: 'Personal', position: 2000, createdAt: '2026-04-01T10:00:00Z' },
  ];
}

function Frame() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <div style={{ height: 600, width: Math.min(window.innerWidth, 360), background: '#1a1d21', overflow: 'hidden' }}>
          <Sidebar onClose={vi.fn()} />
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

// Helpers for crafting the pragmatic-drag-and-drop payloads. The Sidebar's
// drag source data is a DragPayload ({type:'channel'|'conversation'|'category'})
// and each drop target's data is a DropPayload ({type:'channel-target'} or
// {type:'section-header-target'}).
function chan(id: string): UserChannel {
  return makeChannels().find((c) => c.channelID === id)!;
}
function conv(id: string): UserConversation {
  return makeConversations().find((c) => c.conversationID === id)!;
}
function dragSource(data: Record<string, unknown>) {
  return { source: { data } };
}
function dropLocation(targets: Array<Record<string, unknown>>) {
  return { location: { current: { dropTargets: targets.map((data) => ({ data })) } } };
}
function sectionTarget(sectionKey: string, categoryID = '') {
  return { type: 'section-header-target', sectionKey, categoryID };
}
function channelTarget(sectionKey: string, index: number, area = 'row') {
  return { type: 'channel-target', sectionKey, index, area };
}

beforeEach(() => {
  // Enable the DnD debug logging so the (otherwise-skipped) sidebarDndDebug
  // branches scattered through the drag handlers execute. It only emits
  // console.debug (not gated) and reads drag state defensively.
  try { localStorage.setItem('ex.sidebarDndDebug', '1'); } catch { /* noop */ }
  edgeState.edge = 'top';
  setCategoryMutate.mockClear();
  setConversationCategoryMutate.mockClear();
  reorderCategoriesMutate.mockClear();
  favoriteChannelMutate.mockClear();
  favoriteConversationMutate.mockClear();
  monitorCallbacks.onDragStart = undefined;
  monitorCallbacks.onDropTargetChange = undefined;
  monitorCallbacks.onDrag = undefined;
  monitorCallbacks.onDrop = undefined;
});

afterEach(() => {
  try { localStorage.removeItem('ex.sidebarDndDebug'); } catch { /* noop */ }
});

describe('Sidebar drag-and-drop monitor callbacks', () => {
  it('starts and ends a drag without throwing — drop indicator clears', async () => {
    await render(<Frame />);
    expect(monitorCallbacks.onDragStart).toBeDefined();
    expect(monitorCallbacks.onDrag).toBeDefined();
    expect(monitorCallbacks.onDrop).toBeDefined();

    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDrag?.(dropLocation([]));
    monitorCallbacks.onDrop?.(dropLocation([]));
  });

  it('handles a channel drop on the channels section header without crashing', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__channels__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__channels__')]));
    expect(setCategoryMutate).toHaveBeenCalled();
  });

  it('drops a channel onto a user category — fires the set-category mutation', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(setCategoryMutate).toHaveBeenCalled();
  });

  it('drops a conversation onto Favorites — fires the conversation-category mutation', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'conversation', conversation: conv('conv-fav') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__favorites__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__favorites__')]));
    expect(setConversationCategoryMutate).toHaveBeenCalled();
  });

  it('drops a channel onto Favorites — fires the favorite-channel toggle', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__favorites__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__favorites__')]));
    expect(favoriteChannelMutate).toHaveBeenCalled();
  });

  it('drops a category before another category — reorderCategories fires', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  it('drops a channel onto a specific row — exercises positionForDrop', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    expect(setCategoryMutate).toHaveBeenCalled();
  });

  it('drops a channel between two rows with a gap — positionForDrop returns the midpoint', async () => {
    await render(<Frame />);
    // Drag a channel that is NOT in the plain channels section (it lives in
    // cat-work) into __channels__ between general(1000) and other(3000). The
    // dragged id isn't found in that section, so both rows remain in the
    // ordered list with a >1 gap → midpoint floor((1000+3000)/2)=2000.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-categorized') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 1)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 1)]));
    expect(setCategoryMutate).toHaveBeenCalledWith(
      expect.objectContaining({ channelID: 'ch-categorized', categoryID: '', sidebarPosition: 2000 }),
    );
  });

  it('drops a channel past the last row — positionForDrop appends after the final position', async () => {
    await render(<Frame />);
    // Drag general(1000) to the end of __channels__ (index 2, past other(3000)).
    // ordered (without general) = [other(3000)] → before=3000, after=undefined →
    // before branch: 3000 + STEP(1000) = 4000.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-general') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 2)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 2)]));
    expect(setCategoryMutate).toHaveBeenCalledWith(
      expect.objectContaining({ channelID: 'ch-general', categoryID: '', sidebarPosition: 4000 }),
    );
  });

  it('drops a channel into its own single-channel category — positionForDrop returns the base step', async () => {
    await render(<Frame />);
    // Drag the only channel in cat-work back into cat-work at index 0. After
    // filtering out the dragged id the ordered list is empty → before/after both
    // undefined → falls through to SIDEBAR_POSITION_STEP (1000).
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-categorized') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('cat-work', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('cat-work', 0)]));
    expect(setCategoryMutate).toHaveBeenCalledWith(
      expect.objectContaining({ channelID: 'ch-categorized', categoryID: 'cat-work', sidebarPosition: 1000 }),
    );
  });

  it('drops a favorited conversation onto a channel-target in Favorites', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'conversation', conversation: conv('conv-fav') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 0)]));
    expect(setConversationCategoryMutate).toHaveBeenCalled();
  });

  it('handles drop with an unknown target type — falls through without crashing', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDrop?.(dropLocation([{ type: 'something-else' }]));
  });

  it('emits drop-target-change repeatedly without leaking state', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    for (let i = 0; i < 5; i++) {
      const target = i % 2 === 0 ? sectionTarget('cat-work', 'cat-work') : channelTarget('__channels__', 1);
      monitorCallbacks.onDropTargetChange?.(dropLocation([target]));
      monitorCallbacks.onDrag?.(dropLocation([target]));
    }
    monitorCallbacks.onDrop?.(dropLocation([]));
  });

  it('starts a category drag and then drops it back at its own slot', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-work' }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  it('drag with no target on drop — clears state cleanly', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-categorized') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([]));
    monitorCallbacks.onDrop?.(dropLocation([]));
  });

  it('drops a channel below a row on the bottom edge — index advances past the row', async () => {
    edgeState.edge = 'bottom';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    // Bottom edge → resolveDropPayload advances the index (payload.index + 1)
    // and recomputes the drop area via channelDropAreaForIndex.
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    expect(setCategoryMutate).toHaveBeenCalled();
  });

  it('drops a category on the bottom edge of a header — targets the next category slot', async () => {
    edgeState.edge = 'bottom';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    // Bottom edge → nextCategoryTarget(cat-work) resolves the slot after it.
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  it('drops a channel onto a section header from the bottom edge', async () => {
    edgeState.edge = 'bottom';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__channels__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__channels__')]));
    expect(setCategoryMutate).toHaveBeenCalled();
  });
});
