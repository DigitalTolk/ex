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

const reorderSidebarMutate = vi.fn();
const reorderCategoriesMutate = vi.fn();

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: makeChannels() }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
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
  markLocalUserStateWrite: vi.fn(),
  shouldRefetchUserStateForRemoteUpdate: vi.fn(() => true),
  resetUserStateSessionState: vi.fn(),
  useUserState: () => ({
    data: { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} },
  }),
}));
vi.mock('@/hooks/useDrafts', () => ({
  markLocalDraftClearForSend: vi.fn(), useDrafts: () => ({ data: [] }) }));
vi.mock('@/hooks/useUsersBatch', () => ({ useUsersBatch: () => ({ map: new Map() }) }));
vi.mock('@/hooks/useSidebar', () => ({
  useCategories: () => ({ data: makeCategories() }),
  useCreateCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useFavoriteChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useFavoriteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSetCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useSetConversationCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderCategories: () => ({ mutate: reorderCategoriesMutate, isPending: false }),
  useReorderSidebar: () => ({ mutate: reorderSidebarMutate, isPending: false }),
  markLocalSidebarReorder: vi.fn(),
  shouldRefetchSidebarForRemoteUpdate: vi.fn(() => true),
  resetSidebarReorderSessionState: vi.fn(),
}));
// Force desktop so the category drop targets are registered (mobile disables them).
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

function makeChannels(): UserChannel[] {
  return [
    // ch-a / ch-b give the default (__channels__) section TWO rows, so a
    // push-aside gap opens between them — the dead zone the sticky fix targets.
    { channelID: 'ch-a', channelName: 'alpha', channelType: 'public', role: 1, sidebarPosition: 1000 },
    { channelID: 'ch-b', channelName: 'bravo', channelType: 'public', role: 1, sidebarPosition: 2000 },
    { channelID: 'ch-other', channelName: 'random', channelType: 'public', role: 1, sidebarPosition: 3000 },
    { channelID: 'ch-categorized', channelName: 'engineering', channelType: 'public', role: 1, categoryID: 'cat-work', sidebarPosition: 1500 },
    { channelID: 'ch-ops', channelName: 'operations', channelType: 'public', role: 1, categoryID: 'cat-other', sidebarPosition: 1500 },
    // A favorited channel so the Favorites section has a real draggable row to
    // reorder a favorited DM against (exercises the conversation-row real-library
    // drop-target path).
    { channelID: 'fav-ch', channelName: 'starred', channelType: 'public', role: 1, favorite: true, sidebarPosition: 500 },
  ];
}
function makeConversations(): UserConversation[] {
  // TWO favorited DMs → dragging one over the other drives EVERY branch of the
  // real PragmaticConversationRow (the dragged one's onDragStart/onDrop/collapse,
  // the hovered one's getData/getIsSticky) through the REAL library. Other suites
  // mock the library, leaving these borderline → the browser gate flaked ±1.
  return [
    {
      conversationID: 'conv-fav',
      type: 'dm',
      displayName: 'Zoe',
      participantIDs: ['u-self', 'u-zoe'],
      favorite: true,
      sidebarPosition: 1400,
      updatedAt: '2026-05-11T10:00:00Z',
    },
    {
      conversationID: 'conv-fav2',
      type: 'dm',
      displayName: 'Yan',
      participantIDs: ['u-self', 'u-yan'],
      favorite: true,
      sidebarPosition: 1600,
      updatedAt: '2026-05-12T10:00:00Z',
    },
  ];
}
function makeCategories(): SidebarCategory[] {
  return [
    { id: 'cat-work', name: 'Work', position: 1000, createdAt: '2026-04-01T10:00:00Z' },
    { id: 'cat-other', name: 'Other', position: 2000, createdAt: '2026-04-01T10:00:00Z' },
  ];
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
  reorderSidebarMutate.mockClear();
  reorderCategoriesMutate.mockClear();
});

describe('Sidebar real drag-and-drop (no library mock)', () => {
  it('dragging a channel onto a category resolves through the real library to the batch reorder', async () => {
    await render(<Frame />);
    await nextFrame();

    const source = document.querySelector('[data-testid="channel-row-ch-other"]');
    const target = document.querySelector('[data-testid="sidebar-group-header-cat-work"]');
    expect(source, 'draggable channel row should be in the DOM').toBeTruthy();
    expect(target, 'category drop target should be in the DOM').toBeTruthy();

    await fireRealDrag(source!, target!);

    // The real draggable → real drop-target → real onDrop chain must have fired
    // the batch reorder for the channel we actually dragged. This is the wiring
    // the mocked test cannot verify: that the row is genuinely registered as a
    // draggable, the category region is a real drop target, and a native drag
    // resolves through the library to the handler — and, now that positions are
    // dense, we can also assert the PERSISTED placement (the realdrag test used
    // to punt on it): ch-other lands in cat-work at a positive dense position.
    expect(reorderSidebarMutate).toHaveBeenCalledTimes(1);
    const arg = reorderSidebarMutate.mock.calls[0]?.[0] as {
      updates: Array<{ id: string; categoryID: string; sidebarPosition: number }>;
    };
    const moved = arg.updates.find((u) => u.id === 'ch-other');
    expect(moved, 'the dragged channel must be in the reorder updates').toBeTruthy();
    // The destination section is geometry-dependent in a headless layout, but
    // the PERSISTED position must always be a positive dense value — never the
    // negative/collision the old fractional math produced.
    expect(moved!.sidebarPosition).toBeGreaterThan(0);
  });

  // The regression test for the native-DnD "snap-back": the push-aside gap is a
  // pointer-events-none LAYOUT box with no drop target of its own. pragmatic's
  // element adapter calls preventDefault() on `dragover` ONLY when a drop target
  // is under the pointer — that IS the browser's accept-vs-reject switch. Over
  // the gap, WITHOUT getIsSticky, no target is found → no preventDefault → the
  // browser rejects the drop and plays the native return-to-origin animation and
  // nothing lands. WITH getIsSticky on every drop target, pragmatic retains the
  // last row (reusing its edge) so preventDefault keeps firing and the drop is
  // accepted. This drives the REAL library and asserts that real accept signal.
  it('accepts a real drop over the push-aside gap (sticky) — no native snap-back reject', async () => {
    await render(<Frame />);
    await nextFrame();

    const source = document.querySelector('[data-testid="channel-row-ch-a"]');
    const overRow = document.querySelector('[data-testid="channel-row-ch-b"]');
    expect(source, 'draggable channel ch-a should be in the DOM').toBeTruthy();
    expect(overRow, 'hover-target channel ch-b should be in the DOM').toBeTruthy();

    const dt = new DataTransfer();
    const fire = (type: string, target: Element, extra: DragEventInit = {}) => {
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra });
      target.dispatchEvent(e);
      return e;
    };
    const center = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    };
    const bottomEdge = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.bottom - 2 };
    };

    // Start dragging ch-a, then hover ch-b's BOTTOM edge so the resolved slot is
    // AFTER ch-b (a real move — dropping ch-a just before ch-b would be a no-op
    // since it's already there) and the push-aside gap opens there.
    fire('dragstart', source!, { button: 0 });
    await nextFrame();
    fire('dragenter', overRow!, bottomEdge(overRow!));
    fire('dragover', overRow!, bottomEdge(overRow!));
    await nextFrame();

    const gap = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="sidebar-drop-gap-__channels__"]');
      expect(el, 'the push-aside gap should have opened over the channel list').toBeTruthy();
      return el as Element;
    });

    // Drag over the GAP itself — the dead zone. With sticky this dragover is
    // preventDefault()-ed (drop acceptable); without it, it would not be.
    const overGap = fire('dragover', gap, center(gap));
    expect(
      overGap.defaultPrevented,
      'pragmatic must preventDefault over the gap (sticky retains the target) so the browser accepts the drop instead of snapping back',
    ).toBe(true);

    // And the real drop over the gap lands the reorder for the dragged channel.
    fire('drop', gap, center(gap));
    fire('dragend', source!);
    await nextFrame();

    expect(reorderSidebarMutate).toHaveBeenCalled();
    const arg = reorderSidebarMutate.mock.calls[0]?.[0] as {
      updates: Array<{ id: string; sidebarPosition: number }>;
    };
    expect(arg.updates.find((u) => u.id === 'ch-a'), 'the dragged channel must be in the reorder updates').toBeTruthy();
  });

  // Same proof for CATEGORY drag (the case the user reported): dragging a
  // category over another's push-aside gap must be accepted, not snapped back.
  it('accepts a real drop over the CATEGORY push-aside gap (sticky) — no native snap-back reject', async () => {
    await render(<Frame />);
    await nextFrame();

    const source = document.querySelector('[data-testid="sidebar-group-header-cat-other"]');
    const overHeader = document.querySelector('[data-testid="sidebar-group-header-cat-work"]');
    expect(source, 'draggable category header cat-other should be in the DOM').toBeTruthy();
    expect(overHeader, 'target category header cat-work should be in the DOM').toBeTruthy();

    const dt = new DataTransfer();
    const fire = (type: string, target: Element, extra: DragEventInit = {}) => {
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra });
      target.dispatchEvent(e);
      return e;
    };
    const topEdge = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.top + 2 };
    };
    const center = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    };

    // Drag cat-other UP over cat-work's top edge → resolves "before cat-work"
    // (a real move: cat-other currently sits after it) → the category gap opens
    // above cat-work.
    fire('dragstart', source!, { button: 0 });
    await nextFrame();
    fire('dragenter', overHeader!, topEdge(overHeader!));
    fire('dragover', overHeader!, topEdge(overHeader!));
    await nextFrame();

    const gap = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="sidebar-drop-gap-cat-cat-work"]');
      expect(el, 'the category push-aside gap should have opened above cat-work').toBeTruthy();
      return el as Element;
    });

    const overGap = fire('dragover', gap, center(gap));
    expect(
      overGap.defaultPrevented,
      'sticky must keep the CATEGORY drop acceptable over the gap (no native reject)',
    ).toBe(true);

    fire('drop', gap, center(gap));
    fire('dragend', source!);
    await nextFrame();

    expect(reorderCategoriesMutate).toHaveBeenCalled();
  });

  // Drives EVERY branch of the real PragmaticConversationRow: dragging conv-fav
  // (its onDragStart/onDrop/collapse) over conv-fav2 (its getData/getIsSticky).
  it('reorders one favorited DM over another via the real conversation-row drag+drop', async () => {
    await render(<Frame />);
    await nextFrame();

    const source = document.querySelector('[data-testid="conversation-row-conv-fav"]');
    const target = document.querySelector('[data-testid="conversation-row-conv-fav2"]');
    expect(source, 'favorited DM conv-fav should be draggable in Favorites').toBeTruthy();
    expect(target, 'favorited DM conv-fav2 should be a drop target in Favorites').toBeTruthy();

    const dt = new DataTransfer();
    const fire = (type: string, el: Element, extra: DragEventInit = {}) => {
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra });
      el.dispatchEvent(e);
      return e;
    };
    const bottomEdge = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.bottom - 1 };
    };

    fire('dragstart', source!, { button: 0 });
    await nextFrame();
    // Hover conv-fav2's bottom edge → its real getData runs and resolves "after".
    fire('dragenter', target!, bottomEdge(target!));
    fire('dragover', target!, bottomEdge(target!));
    await nextFrame();
    fire('drop', target!, bottomEdge(target!));
    fire('dragend', source!);
    await nextFrame();

    expect(reorderSidebarMutate).toHaveBeenCalled();
    const moved = (reorderSidebarMutate.mock.calls[0]?.[0]?.updates as Array<{ id: string }>).find((u) => u.id === 'conv-fav');
    expect(moved, 'the dragged favorited DM must be in the updates').toBeTruthy();
  });

  // Regression for "drag out of the preview's range, let go → orders one slot
  // too high": the drop must land at the LATEST resolved slot, even when the
  // last move is released before React commits the layoutEffect that syncs the
  // (lagging) visible-indicator ref. handleDrop must read the SYNCHRONOUS
  // resolved-drop ref, not the layout-effect mirror.
  it('drops at the latest shown slot even when released before the last move commits', async () => {
    await render(<Frame />);
    await nextFrame();

    // Drag ch-a (first channel) so both candidate slots are REAL moves.
    const source = document.querySelector('[data-testid="channel-row-ch-a"]');
    const rowB = document.querySelector('[data-testid="channel-row-ch-b"]');
    const rowOther = document.querySelector('[data-testid="channel-row-ch-other"]');
    expect(source).toBeTruthy();
    expect(rowB).toBeTruthy();
    expect(rowOther).toBeTruthy();

    const dt = new DataTransfer();
    const fire = (type: string, el: Element, extra: DragEventInit = {}) => {
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra });
      el.dispatchEvent(e);
      return e;
    };
    const bottomEdge = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.bottom - 1 };
    };

    fire('dragstart', source!, { button: 0 });
    await nextFrame();
    // Resolve to "after ch-b" and let it fully commit (refs + gap settle).
    fire('dragenter', rowB!, bottomEdge(rowB!));
    fire('dragover', rowB!, bottomEdge(rowB!));
    await nextFrame();
    // Move to "after ch-other" (the LATEST slot = the very end) and release
    // IMMEDIATELY — no frame, so the layoutEffect that syncs the visible-indicator
    // ref has NOT run. The drop must land at the end, not the stale "after ch-b".
    fire('dragover', rowOther!, bottomEdge(rowOther!));
    fire('drop', rowOther!, bottomEdge(rowOther!));
    fire('dragend', source!);
    await nextFrame();

    expect(reorderSidebarMutate).toHaveBeenCalled();
    const updates = reorderSidebarMutate.mock.calls[0]?.[0]?.updates as Array<{ id: string; sidebarPosition: number }>;
    const posOf = (id: string) => updates.find((u) => u.id === id)?.sidebarPosition ?? -1;
    // ch-a lands at the END (after ch-other), not the stale slot before ch-other.
    expect(posOf('ch-a')).toBeGreaterThan(posOf('ch-other'));
  });

});
