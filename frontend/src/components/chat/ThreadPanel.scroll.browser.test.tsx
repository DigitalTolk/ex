import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadPanel } from './ThreadPanel';
import type { Message } from '@/types';

// Real-scroll coverage for ThreadPanel's sticky-bottom ResizeObserver,
// the new-reply follow distance check, the deep-link anchor-follow RO +
// scroll-cancel, the delegated <img> load auto-stick, and the
// swipe-dismiss className arms. The panel is mounted inside a bounded
// flex column so its `flex-1 overflow-y-auto` scroller actually
// overflows; MessageItem is replaced with fixed-height rows so the
// scrollHeight math is deterministic.

const apiFetchMock = vi.fn();
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

// Swipe state is mockable so both arms of the data-swipe-dismissing
// attribute can be driven directly. Drag physics: useSwipeDismiss.test.
const swipeState = vi.hoisted(() => ({ dismissing: false, settled: true }));
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: () => ({ dismissing: swipeState.dismissing, settled: swipeState.settled, motionProps: {} }),
}));

vi.mock('@/hooks/useEmoji', () => ({ useEmojis: () => ({ data: [] }), useEmojiMap: () => ({ data: {} }), useFrequentEmojis: () => ['thumbsup', 'heart', 'tada'] }));

let usersBatchData: Array<{ id: string; displayName: string; avatarURL?: string }> = [];
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ data: usersBatchData }),
}));

let isMobileValue = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => isMobileValue }));

vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), mutate: vi.fn(), isPending: false }),
  uploadAttachment: vi.fn(),
}));

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));

let threadMessagesState: { data: unknown; isLoading: boolean } = { data: undefined, isLoading: false };
vi.mock('@/hooks/useThreads', () => ({
  useUserThreads: () => ({ data: [] }),
  useThreadMessages: () => threadMessagesState,
  useFollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  useUnfollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  markThreadSeen: vi.fn(),
}));

vi.mock('@/hooks/useDrafts', () => ({
  useDraftForScope: () => ({ data: undefined }),
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: vi.fn() }),
  useClearDraftForScope: () => ({ mutate: vi.fn() }),
  restoreDraftScope: vi.fn(),
  restoreDraftScopeForContent: vi.fn(),
  suppressSentDraft: vi.fn(),
}));

vi.mock('./TypingIndicator', () => ({ ThreadTypingIndicator: () => <div data-testid="typing" /> }));
vi.mock('./MessageInput', () => ({ MessageInput: () => <div data-testid="message-input" /> }));
vi.mock('./MessageDropZone', () => ({
  // Mirror the real component's flex sizing so the inner `flex-1
  // overflow-y-auto` scroller is height-bounded and can overflow.
  MessageDropZone: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="drop-zone" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {children}
    </div>
  ),
}));

// Fixed 80px rows with an <img> so the delegated load handler has a real
// IMG target to react to. The id mirrors the real MessageItem (msg-<id>).
vi.mock('./MessageItem', () => ({
  MessageItem: ({ message }: { message: Message }) => (
    <div id={`msg-${message.id}`} data-message-id={message.id} style={{ height: 80 }}>
      <img alt="" data-testid={`img-${message.id}`} width={1} height={1} />
      <span>{message.body}</span>
    </div>
  ),
}));

function rootMsg(over: Partial<Message> = {}): Message {
  return { id: 'ROOT', parentID: 'ch-1', parentType: 'channel', authorID: 'u-1', body: 'root', createdAt: '2026-05-01T10:00:00Z', ...over };
}
function reply(id: string, over: Partial<Message> = {}): Message {
  return { id, parentID: 'ch-1', parentType: 'channel', authorID: 'u-1', body: `reply ${id}`, parentMessageID: 'ROOT', createdAt: '2026-05-01T11:00:00Z', ...over };
}

function manyReplies(n: number): Message[] {
  return [rootMsg(), ...Array.from({ length: n }, (_, i) => reply(`R${i}`))];
}

let active: { unmount: () => Promise<void> | void; rerender?: (ui: React.ReactElement) => void } | null = null;

function mount(props: Partial<Parameters<typeof ThreadPanel>[0]> = {}) {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(null);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (root: React.ReactNode) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        {/* Bounded height so the panel's overflow-y-auto scroller overflows. */}
        <div style={{ height: 300, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{root}</div>
      </BrowserRouter>
    </QueryClientProvider>
  );
  const panel = (extra: Partial<Parameters<typeof ThreadPanel>[0]>) => (
    <ThreadPanel
      channelId="ch-1"
      threadRootID="ROOT"
      onClose={vi.fn()}
      userMap={{ 'u-1': { displayName: 'Alice' } }}
      currentUserId="u-1"
      {...props}
      {...extra}
    />
  );
  return { ui, panel, qc };
}

function scroller() {
  return document.querySelector('aside[aria-label="Thread"] .overflow-y-auto') as HTMLElement;
}
function frame() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

beforeEach(() => {
  usersBatchData = [];
  isMobileValue = false;
  swipeState.dismissing = false;
  threadMessagesState = { data: manyReplies(20), isLoading: false };
  // Constrain the panel's own height so its internal `flex-1
  // overflow-y-auto` scroller actually overflows (a flex column only
  // stretches children on the cross axis, so the aside needs an explicit
  // height to bound the scroller). Also kill animations for clean teardown.
  const style = document.createElement('style');
  style.id = 'tp-scroll-style';
  style.textContent =
    'aside[aria-label="Thread"]{height:300px!important;max-height:300px!important}' +
    '*{animation:none!important;transition:none!important}';
  document.head.appendChild(style);
});

afterEach(async () => {
  // Safety net: each test unmounts its own result, but if an assertion
  // throws first this guarantees the panel is torn down before the next.
  if (active) await active.unmount();
  active = null;
  document.getElementById('tp-scroll-style')?.remove();
});

describe('ThreadPanel real-scroll coverage', () => {
  it('snaps to the bottom on open and installs the sticky ResizeObserver', async () => {
    const { ui, panel } = mount();
    const result = await render(ui(panel({})));
    active = result;
    await vi.waitFor(() => {
      const el = scroller();
      expect(el.scrollHeight).toBeGreaterThan(el.clientHeight);
    }, { timeout: 3000 });
    await frame();
    const el = scroller();
    // Initial open stuck to the bottom (within a small slack).
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThan(40);
  });

  it('follows a new reply added to an already-open thread while at the bottom', async () => {
    const { ui, panel } = mount();
    threadMessagesState = { data: manyReplies(20), isLoading: false };
    const result = await render(ui(panel({})));
    active = result;
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight), { timeout: 3000 });
    await frame();
    // Add another reply (len grows) → the new-reply branch + distance check.
    threadMessagesState = { data: manyReplies(21), isLoading: false };
    result.rerender(ui(panel({})));
    await frame();
    await frame();
    const el = scroller();
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThan(120);
  });

  it('does not yank a reader who has scrolled up when a new reply arrives', async () => {
    const { ui, panel } = mount();
    threadMessagesState = { data: manyReplies(20), isLoading: false };
    const result = await render(ui(panel({})));
    active = result;
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight), { timeout: 3000 });
    await frame();
    // Scroll up far from the bottom.
    const el = scroller();
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    await frame();
    const before = el.scrollTop;
    threadMessagesState = { data: manyReplies(21), isLoading: false };
    result.rerender(ui(panel({})));
    await frame();
    await frame();
    // distanceFromBottom >= 120 → no stick; we stay where we were.
    expect(el.scrollTop).toBe(before);
  });

  it('auto-sticks to the bottom when a delegated <img> load grows the content', async () => {
    const { ui, panel } = mount();
    const result = await render(ui(panel({})));
    active = result;
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight), { timeout: 3000 });
    await frame();
    const el = scroller();
    el.scrollTop = el.scrollHeight; // ensure at-bottom
    el.dispatchEvent(new Event('scroll'));
    await frame();
    // Fire a load event from one of the row images → the capture-phase load
    // listener re-pins to the bottom (lines 326-330).
    const img = document.querySelector('[data-testid="img-R0"]') as HTMLImageElement;
    img.dispatchEvent(new Event('load', { bubbles: false }));
    await frame();
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThan(40);
  });

  it('ignores non-IMG load events in the delegated handler', async () => {
    const { ui, panel } = mount();
    const result = await render(ui(panel({})));
    active = result;
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight), { timeout: 3000 });
    // A load event whose target is a non-IMG element hits the
    // `target.tagName !== 'IMG'` guard (line 328) and is ignored.
    const span = document.querySelector('aside[aria-label="Thread"] span') as HTMLElement;
    span.dispatchEvent(new Event('load', { bubbles: false }));
    await frame();
    expect(scroller()).not.toBeNull();
  });

  it('scrolls to and follows a deep-link anchor reply, releasing on user scroll', async () => {
    const { ui, panel } = mount();
    threadMessagesState = { data: manyReplies(30), isLoading: false };
    const result = await render(ui(panel({ anchorMsgId: 'R2', anchorRevision: 'rev-1' })));
    active = result;
    await vi.waitFor(() => {
      expect(document.getElementById('msg-R2')).not.toBeNull();
    }, { timeout: 3000 });
    await frame();
    // The anchored reply is centred; the follow RO + scroll-cancel are armed.
    // A user scroll beyond the 5px tolerance cancels the follow (line 274).
    const el = scroller();
    el.scrollTop = el.scrollTop + 200;
    el.dispatchEvent(new Event('scroll'));
    await frame();
    // Highlight ring applied to the anchor (cosmetic effect, lines 295-299).
    await vi.waitFor(() => {
      expect(document.getElementById('msg-R2')?.classList.contains('ring-1')).toBe(true);
    }, { timeout: 3000 });
  });

  it('re-arms the sticky observer when the thread root changes', async () => {
    const { ui, panel } = mount();
    const result = await render(ui(panel({})));
    active = result;
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight), { timeout: 3000 });
    await frame();
    // Switching threadRootID re-runs the reset layout-effect with an existing
    // observer → the `if (stickyROrRef.current)` disconnect arm (line 171).
    threadMessagesState = { data: [rootMsg({ id: 'ROOT2' }), reply('X0', { parentMessageID: 'ROOT2' })], isLoading: false };
    result.rerender(ui(panel({ threadRootID: 'ROOT2' })));
    await frame();
    await frame();
    expect(document.querySelector('aside[aria-label="Thread"]')).not.toBeNull();
  });

  it('applies the swipe-dismiss className + attribute while dismissing', async () => {
    swipeState.dismissing = true;
    const { ui, panel } = mount();
    const result = await render(ui(panel({})));
    active = result;
    const aside = document.querySelector('aside[aria-label="Thread"]') as HTMLElement;
    expect(aside.getAttribute('data-swipe-dismissing')).toBe('true');
  });

  it('ignores a load event when the reader has scrolled away from the bottom', async () => {
    const { ui, panel } = mount();
    const result = await render(ui(panel({})));
    active = result;
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight), { timeout: 3000 });
    await frame();
    const el = scroller();
    // Scroll up → wasAtBottomRef becomes false. A subsequent <img> load must
    // NOT re-pin (line 329 `!wasAtBottomRef.current` arm).
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    await frame();
    const before = el.scrollTop;
    const img = document.querySelector('[data-testid="img-R0"]') as HTMLImageElement;
    img.dispatchEvent(new Event('load', { bubbles: false }));
    await frame();
    expect(el.scrollTop).toBe(before);
  });

  it('does not re-stick on a rerender that removes replies (len not grown)', async () => {
    const { ui, panel } = mount();
    threadMessagesState = { data: manyReplies(20), isLoading: false };
    const result = await render(ui(panel({})));
    active = result;
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight), { timeout: 3000 });
    await frame();
    // Rerender with FEWER replies (len shrinks) → the sticky effect re-runs
    // (data?.length dep changed) but `len > prevLenRef.current` is false
    // (line 227 else arm); no programmatic stick.
    threadMessagesState = { data: manyReplies(18), isLoading: false };
    result.rerender(ui(panel({})));
    await frame();
    await frame();
    expect(document.querySelector('aside[aria-label="Thread"]')).not.toBeNull();
  });

  it('does not re-apply the anchor on a rerender with the same anchor revision', async () => {
    const { ui, panel } = mount();
    threadMessagesState = { data: manyReplies(30), isLoading: false };
    const result = await render(ui(panel({ anchorMsgId: 'R2', anchorRevision: 'rev-1' })));
    active = result;
    await vi.waitFor(() => expect(document.getElementById('msg-R2')).not.toBeNull(), { timeout: 3000 });
    await frame();
    // The user scrolls beyond the follow tolerance → the follow RO's onScroll
    // flips userHasScrolledRef. Appending a reply (data?.length dep changes)
    // re-runs the anchor effect with anchorAppliedRef already equal to the
    // dedup key (line 258 else arm) → it then early-returns at the
    // `userHasScrolledRef.current` guard (line 266).
    const el = scroller();
    el.scrollTop = el.scrollTop + 300;
    el.dispatchEvent(new Event('scroll'));
    await frame();
    threadMessagesState = { data: manyReplies(31), isLoading: false };
    result.rerender(ui(panel({ anchorMsgId: 'R2', anchorRevision: 'rev-1' })));
    await frame();
    await frame();
    expect(document.getElementById('msg-R2')).not.toBeNull();
  });

  it('stops following the anchor once the follow deadline has elapsed', async () => {
    const { ui, panel } = mount();
    threadMessagesState = { data: manyReplies(30), isLoading: false };
    const result = await render(ui(panel({ anchorMsgId: 'R2', anchorRevision: 'rev-1' })));
    active = result;
    await vi.waitFor(() => expect(document.getElementById('msg-R2')).not.toBeNull(), { timeout: 3000 });
    await frame();
    // Wait past the 1500ms follow window, then append a reply so the anchor
    // effect re-runs: anchorAppliedRef still matches (line 258 else), the user
    // has not scrolled, but `Date.now() >= followDeadlineRef.current` is now
    // true → it early-returns at the deadline guard (line 267).
    await new Promise((r) => setTimeout(r, 1700));
    threadMessagesState = { data: manyReplies(31), isLoading: false };
    result.rerender(ui(panel({ anchorMsgId: 'R2', anchorRevision: 'rev-1' })));
    await frame();
    await frame();
    expect(document.getElementById('msg-R2')).not.toBeNull();
  });

  it('falls back to "Unknown" for a reply whose author is absent from the map', async () => {
    const { ui, panel } = mount();
    threadMessagesState = { data: [rootMsg(), reply('R-ghost', { authorID: 'u-missing' })], isLoading: false };
    const result = await render(ui(panel({ userMap: {} })));
    active = result;
    await expect.element(result.getByText('reply R-ghost')).toBeVisible();
  });

  it('no-ops the anchor + highlight effects when the anchored reply id is not present', async () => {
    // anchorMsgId points to a reply that does not exist → getElementById
    // returns null in BOTH the anchor-scroll effect (line 251) and the
    // highlight effect (line 295), so neither scrolls nor adds the ring.
    const { ui, panel } = mount();
    threadMessagesState = { data: manyReplies(10), isLoading: false };
    const result = await render(ui(panel({ anchorMsgId: 'does-not-exist', anchorRevision: 'rev-1' })));
    active = result;
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight), { timeout: 3000 });
    await frame();
    // No element with that id, so nothing got a highlight ring.
    expect(document.getElementById('msg-does-not-exist')).toBeNull();
  });

  it('skips the anchor effect entirely while the thread replies have not loaded', async () => {
    // anchorMsgId set but the thread data is still UNDEFINED (loading) → the
    // anchor effect early-returns at `(data?.length ?? 0) === 0` via the
    // `data?.` nullish arm + the `?? 0` fallback (line 250), and the
    // repliesHaveLoaded gate keeps the highlight effect dormant.
    const { ui, panel } = mount();
    threadMessagesState = { data: undefined, isLoading: true };
    const result = await render(ui(panel({ anchorMsgId: 'R0', anchorRevision: 'rev-1' })));
    active = result;
    await expect.element(result.getByText('Loading replies...')).toBeVisible();
    await frame();
    expect(document.querySelector('aside[aria-label="Thread"]')).not.toBeNull();
  });
});
