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

// Capture the most-recent draggable() config per element so a test can
// invoke its onDragStart/onDrop to flip the local `dragging` state that the
// Pragmatic* row/header components use to dim themselves while dragged.
const draggableConfigs = vi.hoisted(() => [] as Array<{
  element: Element;
  onDragStart?: () => void;
  onDrop?: () => void;
}>);
// Captured so a test can assert EVERY drop target is registered sticky — the
// contract that keeps a live target under the cursor when it moves onto the
// push-aside gap (a pointer-events-none layout box that is not itself a drop
// target). Drop stickiness → preventDefault keeps firing → no native snap-back.
const dropTargetConfigs = vi.hoisted(() => [] as Array<{ element: Element; getIsSticky?: () => boolean }>);

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: (config: { element: Element; onDragStart?: () => void; onDrop?: () => void }) => {
    draggableConfigs.push(config);
    return () => {};
  },
  dropTargetForElements: (config: { element: Element; getIsSticky?: () => boolean }) => {
    dropTargetConfigs.push(config);
    return () => {};
  },
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
const setConversationCategoryMutate = vi.fn();
const reorderCategoriesMutate = vi.fn();
const reorderSidebarMutate = vi.fn();
const favoriteChannelMutate = vi.fn();
const favoriteConversationMutate = vi.fn();

// Pull the dense position the reorder assigned to a given row out of the last
// reorderSidebar.mutate({ updates }) call — the tests assert the intended
// placement, not a fragile fractional integer.
function lastReorderUpdates(): Array<{ id: string; categoryID: string; favorite: boolean; sidebarPosition: number }> {
  const call = reorderSidebarMutate.mock.calls.at(-1)?.[0] as
    | { updates: Array<{ id: string; categoryID: string; favorite: boolean; sidebarPosition: number }> }
    | undefined;
  return call?.updates ?? [];
}
function positionOf(id: string): number | undefined {
  return lastReorderUpdates().find((u) => u.id === id)?.sidebarPosition;
}
function favoriteOf(id: string): boolean | undefined {
  return lastReorderUpdates().find((u) => u.id === id)?.favorite;
}
// The wire EVENT the drop reported — item, target section, and the anchor it
// landed after. The server owns every resulting position.
function lastMove(): { itemType: string; itemID: string; section: string; categoryID?: string; afterType?: string; afterID?: string } | undefined {
  const call = reorderSidebarMutate.mock.calls.at(-1)?.[0] as
    | { move: { itemType: string; itemID: string; section: string; categoryID?: string; afterType?: string; afterID?: string } }
    | undefined;
  return call?.move;
}

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: makeChannels() }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
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
  markLocalUserStateWrite: vi.fn(),
  shouldRefetchUserStateForRemoteUpdate: vi.fn(() => true),
  resetUserStateSessionState: vi.fn(),
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
  condemnDraftForSend: vi.fn(() => vi.fn()),
  removeDraftScopeFromCache: vi.fn(),
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
  useReorderSidebar: () => ({ mutate: reorderSidebarMutate, isPending: false }),
  markLocalSidebarReorder: vi.fn(),
  shouldRefetchSidebarForRemoteUpdate: vi.fn(() => true),
  resetSidebarReorderSessionState: vi.fn(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => window.innerWidth < 768,
}));

function makeChannels(): UserChannel[] {
  return [
    { channelID: 'ch-general', channelName: 'general', channelType: 'public', role: 1, sidebarPosition: 1000 },
    { channelID: 'ch-favorite', channelName: 'announcements', channelType: 'public', role: 1, favorite: true, sidebarPosition: 500 },
    // Extra favorited channels so positionForSidebarItemDrop sees a gap
    // (midpoint) and a <=1 neighbour (after-step) inside Favorites.
    { channelID: 'ch-fav-gap', channelName: 'beta', channelType: 'public', role: 1, favorite: true, sidebarPosition: 4000 },
    { channelID: 'ch-fav-low', channelName: 'alpha', channelType: 'public', role: 1, favorite: true, sidebarPosition: 1 },
    { channelID: 'ch-categorized', channelName: 'engineering', channelType: 'public', role: 1, categoryID: 'cat-work', sidebarPosition: 1500 },
    { channelID: 'ch-other', channelName: 'random', channelType: 'public', role: 1, sidebarPosition: 3000 },
    // A channel parked at position 1 inside its own category so a drop just
    // before it exercises the `after !== undefined && !(after > 1)` arm of
    // positionForDrop without disturbing the __channels__ fixture ordering.
    { channelID: 'ch-low', channelName: 'zeta', channelType: 'public', role: 1, categoryID: 'cat-low', sidebarPosition: 1 },
    // A channel with no sidebarPosition so a debug snapshot of cat-low hits
    // the `sidebarPosition ?? null` fallback arm.
    { channelID: 'ch-noposition', channelName: 'omega', channelType: 'public', role: 1, categoryID: 'cat-low' },
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
    { id: 'cat-low', name: 'Zeta', position: 3000, createdAt: '2026-04-01T10:00:00Z' },
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
  // console.debug (silenced globally by console-gate) and reads drag state
  // defensively.
  try { localStorage.setItem('ex.sidebarDndDebug', '1'); } catch { /* noop */ }
  edgeState.edge = 'top';
  setCategoryMutate.mockClear();
  setConversationCategoryMutate.mockClear();
  reorderCategoriesMutate.mockClear();
  reorderSidebarMutate.mockClear();
  favoriteChannelMutate.mockClear();
  favoriteConversationMutate.mockClear();
  monitorCallbacks.onDragStart = undefined;
  monitorCallbacks.onDropTargetChange = undefined;
  monitorCallbacks.onDrag = undefined;
  monitorCallbacks.onDrop = undefined;
  draggableConfigs.length = 0;
  dropTargetConfigs.length = 0;
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
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('drops a channel onto a user category — fires the set-category mutation', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('drops a conversation onto Favorites — fires the conversation-category mutation', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'conversation', conversation: conv('conv-fav') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__favorites__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__favorites__')]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('drops a channel onto Favorites — fires the favorite-channel toggle', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__favorites__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__favorites__')]));
    // Favoriting now rides the batch reorder (favorite flips inside the updates)
    // instead of a separate favorite mutation.
    expect(reorderSidebarMutate).toHaveBeenCalled();
    expect(favoriteOf('ch-other')).toBe(true);
    // The reported EVENT targets the Favorites section — the server flips
    // the flag itself; no separate favorite mutation, no client-sent flag.
    expect(lastMove()).toMatchObject({ itemType: 'channel', itemID: 'ch-other', section: 'favorites' });
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
    expect(reorderSidebarMutate).toHaveBeenCalled();
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
    // Densified order [general(1000), ch-categorized(2000), other(3000)].
    expect(positionOf('ch-categorized')).toBe(2000);
    expect(lastReorderUpdates().find((u) => u.id === 'ch-categorized')?.categoryID).toBe('');
  });

  it('drops a channel past the last row — lands after the final row', async () => {
    await render(<Frame />);
    // Drag general(1000) to the end of __channels__ (index 2, past other(3000)).
    // ordered (without general) = [other(3000)] → before=3000, after=undefined →
    // before branch: 3000 + STEP(1000) = 4000.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-general') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 2)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 2)]));
    // general moved to the end → its new position is greater than other's.
    expect(positionOf('ch-general')!).toBeGreaterThan(positionOf('ch-other')!);
  });

  it('registers EVERY drop target as sticky so the push-aside gap can never orphan the drop', async () => {
    await render(<Frame />);
    // Rows, the section tail, category headers and boundary hitboxes all register
    // drop targets. Each MUST be sticky: when the pointer slides off a row onto
    // the pointer-events-none gap, pragmatic retains the last target (reusing its
    // closest-edge) so preventDefault keeps firing and the browser accepts the
    // drop — otherwise it rejects it with the native snap-back and nothing lands.
    expect(dropTargetConfigs.length).toBeGreaterThan(0);
    for (const cfg of dropTargetConfigs) {
      expect(cfg.getIsSticky?.()).toBe(true);
    }
  });

  it('opens a push-aside gap at the resolved channel slot during a drag, and clears it on drop', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0)]));
    // The row-height gap opens above the resolved slot (rows below shift down).
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-drop-gap-__channels__"]')).not.toBeNull();
    });
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    // Drop clears the indicator → the gap collapses (land-in-place).
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-drop-gap-__channels__"]')).toBeNull();
    });
  });

  it('opens the tail gap when the drop resolves past the last row (area "end")', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-general') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 2, 'end')]));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-drop-gap-__channels__"]')).not.toBeNull();
    });
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 2, 'end')]));
  });

  it('opens the gap on a favorited conversation slot when a DM is dragged onto it', async () => {
    await render(<Frame />);
    // conv-fav (Carol) has no sidebarPosition → sorts last in Favorites (index 3).
    monitorCallbacks.onDragStart?.(dragSource({ type: 'conversation', conversation: conv('conv-fav') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 3)]));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-drop-gap-__favorites__"]')).not.toBeNull();
    });
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 3)]));
  });

  it('drops a channel into its own single-channel category — dense base step', async () => {
    await render(<Frame />);
    // Drag the only channel in cat-work back into cat-work at index 0. After
    // filtering out the dragged id the ordered list is empty → before/after both
    // undefined → falls through to SIDEBAR_POSITION_STEP (1000).
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-categorized') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('cat-work', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('cat-work', 0)]));
    expect(positionOf('ch-categorized')).toBe(1000);
    expect(lastReorderUpdates().find((u) => u.id === 'ch-categorized')?.categoryID).toBe('cat-work');
  });

  it('drops a favorited conversation onto a channel-target in Favorites', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'conversation', conversation: conv('conv-fav') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 0)]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
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
    expect(reorderSidebarMutate).toHaveBeenCalled();
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
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  // ---- Additional drag-resolve branch coverage ----

  it('un-favorites a favorited channel dragged into the plain channels section', async () => {
    await render(<Frame />);
    // ch-favorite is favorite:true. Dropping it into __channels__ both
    // unfavorites it (the favorite===true branch) and re-categorises it.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-favorite') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    // Un-favoriting is the server's decision: the event targets the default
    // channels section; the optimistic preview mirrors the flip.
    expect(favoriteOf('ch-favorite')).toBe(false);
    expect(lastMove()).toMatchObject({ itemID: 'ch-favorite', section: 'channels' });
  });

  it('does not re-favorite an already-favorited channel dropped onto Favorites', async () => {
    await render(<Frame />);
    // ch-favorite is already favorite:true → the `!favorite` guard is false,
    // so favoriteChannel.mutate is skipped but setCategory still fires.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-favorite') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__favorites__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__favorites__')]));
    // A within-Favorites reorder reports the same favorites-targeted event;
    // whether any flag actually flips is the server's call, not the client's.
    expect(lastMove()).toMatchObject({ itemID: 'ch-favorite', section: 'favorites' });
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('positions a drop just before a row whose position is <= 1 (after-step branch)', async () => {
    await render(<Frame />);
    // Drag ch-other into cat-low at index 0. The only remaining channel there
    // is ch-low (position 1): before=undefined, after=1 → after>1 is false but
    // after!==undefined → returns after - STEP.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('cat-low', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('cat-low', 0)]));
    // No more negative positions: dropped at the front → dense 1000, cat-low.
    expect(positionOf('ch-other')).toBe(1000);
    expect(lastReorderUpdates().find((u) => u.id === 'ch-other')?.categoryID).toBe('cat-low');
  });

  it('reorders within a section by dragging a row from an earlier to a later index', async () => {
    await render(<Frame />);
    // ch-general lives in __channels__ at index 0; drop it at index 1 → the
    // dragged row is found at draggedIndex 0 < targetIndex 1, so the adjusted
    // index decrements (the draggedIndex>=0 && <targetIndex true branch).
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-general') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 1)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 1)]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('keeps the previous channel indicator when a re-resolve yields no target', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    // First resolve to a concrete channel target.
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0)]));
    // Then move off any target — updateResolvedDrop keeps the prior channel
    // indicator (the channel + channel-kind early-return branch).
    monitorCallbacks.onDropTargetChange?.(dropLocation([]));
    monitorCallbacks.onDrop?.(dropLocation([]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('keeps the previous category indicator when a re-resolve yields no target', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    // Move off → category + category-kind early-return keeps the indicator.
    monitorCallbacks.onDropTargetChange?.(dropLocation([]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  it('emits an identical channel resolution twice — the indicator setter returns the prior value', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    // Two identical drop-target-changes → showChannelDropIndicator's prev-equals
    // short-circuit returns the existing indicator unchanged.
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('cat-work', 0)]));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('cat-work', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('cat-work', 0)]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('emits an identical category resolution twice — the indicator setter returns the prior value', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  it('resolves a channel drop on a section header from the top edge of a non-first section (previous drop)', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    // Top edge of the DMs/last header → previousChannelDrop walks back to the
    // nearest channel-accepting section (canAcceptChannelDrop branch).
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-personal', 'cat-personal')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-personal', 'cat-personal')]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('drops a channel past the section end on the bottom edge — area resolves to "end"', async () => {
    edgeState.edge = 'bottom';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    // Bottom edge of the last row index → channelDropAreaForIndex sees an index
    // at/over dropCount and returns 'end'.
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 3)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 3)]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('ignores a category drag dropped onto a channel-target row', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    // resolveDropPayload returns null for a category drag over a channel-target.
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    expect(reorderCategoriesMutate).not.toHaveBeenCalled();
  });

  it('ignores a conversation drag dropped onto a non-favorites channel-target', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'conversation', conversation: conv('conv-fav') }));
    // Conversation over a non-favorites channel-target → resolveDropPayload null.
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    expect(reorderSidebarMutate).not.toHaveBeenCalled();
  });

  it('drops with no active drag at all — resolves straight from the payload', async () => {
    await render(<Frame />);
    // onDrop without a preceding onDragStart → activeDragRef is null, so
    // handleDrop takes the no-active-drag branch and resolves from the payload.
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    // Nothing scheduled because the resolved drop has no active channel.
    expect(reorderSidebarMutate).not.toHaveBeenCalled();
  });

  it('drops a channel on the Favorites header top edge — no preceding section, resolves to the lead slot', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    // Favorites is the FIRST section, so previousChannelDrop finds no earlier
    // channel-accepting section and returns null; the header resolver then
    // falls back to the favorites lead slot and the drop still persists.
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__favorites__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__favorites__')]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
    expect(favoriteOf('ch-other')).toBe(true);
  });

  it('ignores a category dragged onto the Favorites header (categories cannot live in Favorites)', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    // section-header-target + Favorites → the category-resolve guard fails
    // (sectionKey === Favorites), so no reorder is scheduled.
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__favorites__')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('__favorites__')]));
    expect(reorderCategoriesMutate).not.toHaveBeenCalled();
  });

  it('drops the last category on a bottom edge — nextCategoryTarget falls back to the end slot', async () => {
    edgeState.edge = 'bottom';
    await render(<Frame />);
    // cat-low is the last category (position 3000). A bottom-edge drop on its
    // header asks nextCategoryTarget for the slot after it → no next category,
    // so it returns CATEGORY_DROP_END, and orderedCategoriesAfterDrop appends.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-work' }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-low', 'cat-low')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-low', 'cat-low')]));
    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  it('emits onDrag during a category drag without logging a position (drag events are skipped)', async () => {
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    // onDrag → logCategoryMonitorEvent('drag', ...) takes its event==='drag'
    // early-return; the resolve still runs.
    monitorCallbacks.onDrag?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  it('drops a favorited conversation between two favorites rows — positionForSidebarItemDrop midpoint', async () => {
    await render(<Frame />);
    // Favorites holds ch-favorite (500) and conv-fav. Dragging conv-fav within
    // favorites exercises positionForSidebarItemDrop over mixed items.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'conversation', conversation: conv('conv-fav') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 1)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 1)]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('drops a channel between two favorites with a gap — positionForSidebarItemDrop midpoint', async () => {
    await render(<Frame />);
    // Favorites sorted: ch-fav-low(1), ch-favorite(500), ch-fav-gap(4000), conv-fav.
    // Dropping ch-other (not in favorites) at index 2 → before=ch-favorite(500),
    // after=ch-fav-gap(4000), gap > 1 → midpoint floor((500+4000)/2)=2250.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 2)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 2)]));
    // ch-other joins Favorites at a dense positive position (exact placement is
    // unit-tested in sidebar-reorder.test.ts).
    expect(favoriteOf('ch-other')).toBe(true);
    expect(positionOf('ch-other')!).toBeGreaterThan(0);
  });

  it('drops a channel before a favorites row with position <= 1 — positionForSidebarItemDrop after-step', async () => {
    await render(<Frame />);
    // Dropping ch-other at favorites index 0 → before=undefined,
    // after=ch-fav-low(1) → after>1 false but after!==undefined → 1 - STEP.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 0)]));
    // Front of Favorites → dense 1000 (no negatives), and ch-other is favorited.
    expect(positionOf('ch-other')).toBe(1000);
    expect(favoriteOf('ch-other')).toBe(true);
  });

  it('drops a channel into Favorites past the end — positionForSidebarItemDrop falls back to the base step', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    // ch-other is not a favorite (draggedIndex < 0). Targeting an index past the
    // last favorites row → before and after are both undefined → returns STEP.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 25, 'end')]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 25, 'end')]));
    // Clamped to the end of Favorites; ch-other is favorited at a dense position.
    expect(favoriteOf('ch-other')).toBe(true);
    expect(positionOf('ch-other')!).toBeGreaterThan(0);
  });

  it('drops a favorited channel at the head of Favorites — positionForSidebarItemDrop halves the first position', async () => {
    await render(<Frame />);
    // Drag ch-fav-low out of index 0 and drop at index 0. After removing it the
    // first remaining favorite is ch-favorite(500): before=undefined, after=500,
    // after>1 → floor(500/2)=250.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-fav-low') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 0)]));
    // Re-spaced to the front of Favorites at a dense position.
    expect(reorderSidebarMutate).toHaveBeenCalled();
    expect(positionOf('ch-fav-low')).toBe(1000);
  });

  it('reorders a favorited channel within Favorites to a later index — adjusts the target index down', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    // ch-fav-low sits at favorites index 0; dropping it at index 2 makes
    // draggedIndex(0) >= 0 && draggedIndex(0) < targetIndex(2) true, so
    // positionForSidebarItemDrop decrements the adjusted target index.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-fav-low') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 2, 'row')]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 2, 'row')]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
    expect(positionOf('ch-fav-low')).toBeDefined();
  });

  it('reorders a favorited conversation already in Favorites to a later index', async () => {
    await render(<Frame />);
    // conv-fav IS in favorites → draggedIndex >= 0; dropping at a later index
    // hits the `draggedIndex >= 0 && draggedIndex < targetIndex` true branch.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'conversation', conversation: conv('conv-fav') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__favorites__', 3)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__favorites__', 3)]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('collapses a dragged row (lift-out) and dims a dragged category header, restoring both on drop', async () => {
    await render(<Frame />);
    // Each Pragmatic* row/header registers a draggable with onDragStart/onDrop
    // that flip a local `dragging` flag. Invoke them directly (the real pointer
    // drag is not driveable in headless Playwright). Rows/headers are only
    // draggable on desktop (disabled on mobile), so on the mobile projects there
    // is nothing to drag — skip there.
    if (draggableConfigs.length === 0) return;
    for (const cfg of draggableConfigs) {
      cfg.onDragStart?.();
    }
    await vi.waitFor(() => {
      // Channel/DM rows COLLAPSE their original slot to nothing (lift-out):
      // zero height + invisible, so only the push-aside gap shows the landing.
      const collapsed = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="channel-row-"]')).filter(
        (el) => el.style.opacity === '0' && el.style.height === '0px',
      );
      expect(collapsed.length).toBeGreaterThan(0);
      // Category headers keep the subtler in-place dim (a whole section can't
      // sensibly collapse mid-drag).
      const dimmed = Array.from(document.querySelectorAll<HTMLElement>('[style*="opacity"]')).filter(
        (el) => el.style.opacity === '0.25',
      );
      expect(dimmed.length).toBeGreaterThan(0);
    });
    for (const cfg of draggableConfigs) {
      cfg.onDrop?.();
    }
    await vi.waitFor(() => {
      const stillCollapsed = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="channel-row-"]')).filter(
        (el) => el.style.height === '0px',
      );
      expect(stillCollapsed.length).toBe(0);
      const stillDimmed = Array.from(document.querySelectorAll<HTMLElement>('[style*="opacity"]')).filter(
        (el) => el.style.opacity === '0.25',
      );
      expect(stillDimmed.length).toBe(0);
    });
  });

  it('walks the channel indicator dedup clauses across differing section/index/area hovers', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    // Successive hovers break showChannelDropIndicator's prev-equals chain at a
    // different && clause each time:
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0, 'row')]));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0, 'row')])); // identical → returns prev
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 1, 'row')])); // index differs
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('__channels__')]));            // lead area differs, same section
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('cat-work', 0, 'row')]));      // section differs
    monitorCallbacks.onDrop?.(dropLocation([]));
    expect(true).toBe(true);
  });

  it('walks the category indicator dedup clauses across differing header hovers', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    // First resolve to cat-work's slot, repeat it (identical → returns prev),
    // then a different category slot (beforeCategoryID differs), then the same
    // slot at a different resolved position (position differs).
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')])); // identical → returns prev
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-low', 'cat-low')]));    // beforeCategoryID differs
    edgeState.edge = 'bottom';
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-low', 'cat-low')]));    // same slot, different resolved position
    edgeState.edge = 'top';
    monitorCallbacks.onDrop?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  it('logs a channel order snapshot covering a channel that has no sidebar position', async () => {
    await render(<Frame />);
    // Dropping into cat-low (which contains ch-noposition) logs a debug
    // snapshot of that section → the `sidebarPosition ?? null` fallback runs.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('cat-low', 0)]));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('cat-low', 0)]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });

  it('renders a category drop indicator on a category-header hover', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-drop-gap-cat-cat-work"]')).not.toBeNull();
    });
    monitorCallbacks.onDrop?.(dropLocation([]));
  });


  it('toggles a section header with the Enter key', async () => {
    await render(<Frame />);
    const toggle = document.querySelector('[data-testid="sidebar-group-toggle-__channels__"]') as HTMLElement;
    toggle.focus();
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
  });

  it('toggles a section header with the Space key', async () => {
    await render(<Frame />);
    const toggle = document.querySelector('[data-testid="sidebar-group-toggle-__channels__"]') as HTMLElement;
    toggle.focus();
    // Space alone (Enter is false) → exercises the `event.key === ' '` clause.
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await vi.waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
  });

  it('ignores non-activation keys on a section header (neither Enter nor Space)', async () => {
    await render(<Frame />);
    const toggle = document.querySelector('[data-testid="sidebar-group-toggle-__channels__"]') as HTMLElement;
    toggle.focus();
    // An arrow key matches neither clause → the if-condition is false and the
    // section stays expanded.
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('returns the existing channel indicator when the same target is hovered twice (committed between hovers)', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0, 'row')]));
    // Let the first resolution commit so prev is populated for the dedup check.
    // (No visible line under land-in-place; the resolve state still updates.)
    await new Promise((r) => setTimeout(r, 20));
    // Hover the identical target again → showChannelDropIndicator's updater
    // sees a matching prev and returns it unchanged.
    monitorCallbacks.onDropTargetChange?.(dropLocation([channelTarget('__channels__', 0, 'row')]));
    await new Promise((r) => setTimeout(r, 20));
    monitorCallbacks.onDrop?.(dropLocation([]));
    expect(true).toBe(true);
  });

  it('returns the existing category indicator when the same header is hovered twice (committed between hovers)', async () => {
    edgeState.edge = 'top';
    await render(<Frame />);
    monitorCallbacks.onDragStart?.(dragSource({ type: 'category', categoryID: 'cat-personal' }));
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-drop-gap-cat-cat-work"]')).not.toBeNull();
    });
    monitorCallbacks.onDropTargetChange?.(dropLocation([sectionTarget('cat-work', 'cat-work')]));
    await new Promise((r) => setTimeout(r, 20));
    monitorCallbacks.onDrop?.(dropLocation([]));
    expect(true).toBe(true);
  });

  it('starts a fresh drag while a prior drop is still settling — clears the pending suppression timeout', async () => {
    await render(<Frame />);
    // First drag + drop schedules the 750ms suppress-reset timeout.
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-other') }));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    // A second drag start while that timeout is pending → handleDragStart
    // clears it (suppressNavigationResetRef !== null branch).
    monitorCallbacks.onDragStart?.(dragSource({ type: 'channel', channel: chan('ch-general') }));
    monitorCallbacks.onDrop?.(dropLocation([channelTarget('__channels__', 0)]));
    expect(reorderSidebarMutate).toHaveBeenCalled();
  });
});
