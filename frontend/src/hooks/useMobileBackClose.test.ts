import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMobileBackClose, resetMobileBackCloseForTests } from '@/hooks/useMobileBackClose';

let mockIsMobile = true;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));

const MARKER = '__exOverlayBackClose';

// Simulates the browser completing a Back traversal: history lands on `state`
// and popstate fires. jsdom's own history.back() is async and entangles the
// URL, so the tests drive the pop directly for determinism.
function popTo(state: unknown) {
  window.history.replaceState(state, '');
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
}

function markerOf(state: unknown): unknown {
  return (state as Record<string, unknown> | null)?.[MARKER];
}

describe('useMobileBackClose', () => {
  let backSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockIsMobile = true;
    window.history.replaceState(null, '');
    backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    // The back() spy swallows queued consume traversals — clear the module
    // bookkeeping so they can't leak between tests.
    resetMobileBackCloseForTests();
  });

  afterEach(() => {
    backSpy.mockRestore();
  });

  it('does not arm when closed, on desktop, or without a close handler', () => {
    const push = vi.spyOn(window.history, 'pushState');
    const onClose = vi.fn();
    const closed = renderHook(() => useMobileBackClose(false, onClose));
    closed.unmount();
    mockIsMobile = false;
    const desktop = renderHook(() => useMobileBackClose(true, onClose));
    desktop.unmount();
    mockIsMobile = true;
    const handlerless = renderHook(() => useMobileBackClose(true, undefined));
    handlerless.unmount();
    expect(push).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it('pushes a sentinel while open and closes on Back past it', () => {
    const onClose = vi.fn();
    renderHook(() => useMobileBackClose(true, onClose));
    expect(markerOf(window.history.state)).toEqual(expect.any(Number));
    // Back: the browser pops the sentinel; the restored entry has no marker.
    popTo(null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('preserves the router bookkeeping fields on the sentinel entry', () => {
    window.history.replaceState({ idx: 7 }, '');
    renderHook(() => useMobileBackClose(true, vi.fn()));
    expect((window.history.state as { idx: number }).idx).toBe(7);
    expect(markerOf(window.history.state)).toEqual(expect.any(Number));
  });

  it('handles a non-object base history state', () => {
    window.history.replaceState('opaque', '');
    renderHook(() => useMobileBackClose(true, vi.fn()));
    expect(markerOf(window.history.state)).toEqual(expect.any(Number));
  });

  it('closing through the UI consumes the sentinel with one history.back()', () => {
    const onClose = vi.fn();
    const view = renderHook(({ open }) => useMobileBackClose(open, onClose), {
      initialProps: { open: true },
    });
    view.rerender({ open: false });
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves history alone when a real navigation already replaced the sentinel', () => {
    const onClose = vi.fn();
    const view = renderHook(({ open }) => useMobileBackClose(open, onClose), {
      initialProps: { open: true },
    });
    // e.g. a sidebar row click pushed a new route on top of the sentinel.
    window.history.replaceState({ idx: 9 }, '');
    view.rerender({ open: false });
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('a stacked overlay consuming its sentinel does not close the outer overlay', () => {
    const outerClose = vi.fn();
    renderHook(() => useMobileBackClose(true, outerClose));
    const outerState = window.history.state;
    const innerClose = vi.fn();
    const inner = renderHook(() => useMobileBackClose(true, innerClose));
    // Inner overlay closed through its UI: its cleanup consumes ITS sentinel
    // and history settles back on the outer sentinel.
    inner.unmount();
    popTo(outerState);
    expect(outerClose).not.toHaveBeenCalled();
    expect(innerClose).not.toHaveBeenCalled();
    // A real Back now pops the outer sentinel (a NUMERIC marker smaller than
    // the outer id — e.g. a much older overlay entry — must also close).
    popTo({ [MARKER]: 0 });
    expect(outerClose).toHaveBeenCalledTimes(1);
  });

  it('tolerates the close handler vanishing while armed', () => {
    const view = renderHook(
      ({ cb }: { cb: (() => void) | undefined }) => useMobileBackClose(true, cb),
      { initialProps: { cb: vi.fn() as (() => void) | undefined } },
    );
    view.rerender({ cb: undefined });
    expect(() => popTo(null)).not.toThrow();
  });

  it('a user Back on stacked overlays closes only the inner one', () => {
    const outerClose = vi.fn();
    renderHook(() => useMobileBackClose(true, outerClose));
    const outerState = window.history.state;
    const innerClose = vi.fn();
    renderHook(() => useMobileBackClose(true, innerClose));
    // User presses Back: the browser pops the INNER sentinel and lands on the
    // outer one — the outer overlay must stay open.
    popTo(outerState);
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });

  it('a queued consume traversal never closes a newly-armed overlay — it restores the eaten sentinel', async () => {
    // Overlay A closes through its UI: cleanup queues history.back() (async
    // in a real browser). Overlay B arms BEFORE the traversal lands, so the
    // traversal pops B's sentinel — B must NOT treat that as a user Back.
    const closeA = vi.fn();
    const a = renderHook(() => useMobileBackClose(true, closeA));
    a.unmount(); // queues the consume (back() is spied to a no-op)
    expect(backSpy).toHaveBeenCalledTimes(1);
    const closeB = vi.fn();
    renderHook(() => useMobileBackClose(true, closeB));
    const bMarker = markerOf(window.history.state);
    // The queued traversal lands: history settles below B's sentinel.
    popTo(null);
    expect(closeB).not.toHaveBeenCalled();
    // B restored its sentinel so a REAL Back still closes it.
    expect(markerOf(window.history.state)).toBe(bMarker);
    // The consume stamp is per-event — the next (user) Back closes B normally.
    popTo(null);
    expect(closeB).toHaveBeenCalledTimes(1);
  });
});
