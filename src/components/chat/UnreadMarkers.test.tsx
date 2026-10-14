import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NewBelowPill, UNREAD_DIVIDER_LINGER_MS, UnreadBanner, UnreadDivider } from './UnreadMarkers';

// jsdom has no IntersectionObserver; this stands in for it and lets a test
// say when the line is on screen.
type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
const observers: Array<{ cb: IOCallback; observed: Element[]; disconnected: boolean }> = [];
function installIntersectionObserver() {
  observers.length = 0;
  class FakeIO {
    private rec: { cb: IOCallback; observed: Element[]; disconnected: boolean };
    constructor(cb: IOCallback) {
      this.rec = { cb, observed: [], disconnected: false };
      observers.push(this.rec);
    }
    observe(el: Element) { this.rec.observed.push(el); }
    disconnect() { this.rec.disconnected = true; }
    unobserve() {}
    takeRecords() { return []; }
  }
  vi.stubGlobal('IntersectionObserver', FakeIO);
}

describe('UnreadDivider fade', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // jsdom's window never has focus; the reader is at this window unless a
  // test says otherwise.
  function windowInFront(front = true) {
    vi.spyOn(document, 'hasFocus').mockReturnValue(front);
  }
  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('stays while on screen and fades once it has been seen for 30 minutes, then reports it', () => {
    vi.useFakeTimers();
    windowInFront();
    installIntersectionObserver();
    const onSeen = vi.fn();
    render(<UnreadDivider onSeen={onSeen} />);
    expect(observers).toHaveLength(1);
    const line = screen.getByTestId('unread-divider');
    // Not on screen yet: nothing starts.
    act(() => observers[0].cb([{ isIntersecting: false }]));
    act(() => vi.advanceTimersByTime(UNREAD_DIVIDER_LINGER_MS + 1000));
    expect(line.className).not.toContain('opacity-0');
    expect(onSeen).not.toHaveBeenCalled();
    // On screen: the observer lets go; the line stays a long while (not the
    // old 3 seconds), then fades, and the owner hears once the fade has run.
    act(() => observers[0].cb([{ isIntersecting: true }]));
    expect(observers[0].disconnected).toBe(true);
    act(() => vi.advanceTimersByTime(UNREAD_DIVIDER_LINGER_MS - 1));
    expect(line.className).not.toContain('opacity-0');
    act(() => vi.advanceTimersByTime(1));
    expect(line.className).toContain('opacity-0');
    expect(onSeen).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it('retires when the reader leaves the window after seeing it', () => {
    vi.useFakeTimers();
    windowInFront();
    installIntersectionObserver();
    const onSeen = vi.fn();
    render(<UnreadDivider onSeen={onSeen} />);
    act(() => observers[0].cb([{ isIntersecting: true }]));
    act(() => vi.advanceTimersByTime(60_000));
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(screen.getByTestId('unread-divider').className).toContain('opacity-0');
    act(() => vi.advanceTimersByTime(500));
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it('retires when the tab is hidden after seeing it, but not on a visible change', () => {
    vi.useFakeTimers();
    windowInFront();
    installIntersectionObserver();
    const onSeen = vi.fn();
    try {
      render(<UnreadDivider onSeen={onSeen} />);
      act(() => observers[0].cb([{ isIntersecting: true }]));
      act(() => setVisibility('visible'));
      act(() => vi.advanceTimersByTime(1000));
      expect(onSeen).not.toHaveBeenCalled();
      act(() => setVisibility('hidden'));
      act(() => vi.advanceTimersByTime(500));
      expect(onSeen).toHaveBeenCalledTimes(1);
    } finally {
      setVisibility('visible');
    }
  });

  // Arriving while the reader is in another app, the line is on screen but
  // nobody has seen it: it waits for them to come back.
  it('is not seen while the window is in the background; coming back makes it seen', () => {
    vi.useFakeTimers();
    windowInFront(false);
    installIntersectionObserver();
    const onSeen = vi.fn();
    render(<UnreadDivider onSeen={onSeen} />);
    act(() => observers[0].cb([{ isIntersecting: true }]));
    act(() => vi.advanceTimersByTime(UNREAD_DIVIDER_LINGER_MS + 1000));
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onSeen).not.toHaveBeenCalled();

    windowInFront(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    // A second return changes nothing: it is seen once.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    act(() => vi.advanceTimersByTime(500));
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it('a second sighting is ignored, and unmounting cancels the timers', () => {
    vi.useFakeTimers();
    windowInFront();
    installIntersectionObserver();
    const onSeen = vi.fn();
    const { unmount } = render(<UnreadDivider onSeen={onSeen} />);
    act(() => observers[0].cb([{ isIntersecting: true }]));
    act(() => observers[0].cb([{ isIntersecting: true }]));
    act(() => vi.advanceTimersByTime(UNREAD_DIVIDER_LINGER_MS));
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(onSeen).not.toHaveBeenCalled();
  });

  it('watches nothing without onSeen or once retired, and a retired line keeps its box but is invisible', () => {
    installIntersectionObserver();
    const { rerender } = render(<UnreadDivider />);
    expect(observers).toHaveLength(0);
    rerender(<UnreadDivider onSeen={vi.fn()} retired />);
    expect(observers).toHaveLength(0);
    const line = screen.getByTestId('unread-divider');
    expect(line).toHaveAttribute('data-retired', 'true');
    expect(line).toHaveAttribute('aria-hidden', 'true');
    expect(line.className).toContain('invisible');
    expect(line.className).toContain('py-1');
  });

  it('keeps working without an IntersectionObserver at all (no fade)', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onSeen = vi.fn();
    render(<UnreadDivider onSeen={onSeen} />);
    expect(screen.getByTestId('unread-divider')).toBeInTheDocument();
    expect(onSeen).not.toHaveBeenCalled();
  });
});

describe('UnreadMarkers', () => {
  it('the line is a labelled separator the list can find', () => {
    render(<UnreadDivider />);
    const line = screen.getByRole('separator', { name: 'New messages' });
    expect(line).toHaveAttribute('data-unread-divider');
  });

  it('the banner jumps back or marks it all read, with a count that reads right', () => {
    const onJump = vi.fn();
    const onMarkRead = vi.fn();
    const { rerender } = render(<UnreadBanner count={1} onJump={onJump} onMarkRead={onMarkRead} />);
    expect(screen.getByTestId('unread-banner')).toHaveTextContent('1 new message');
    rerender(<UnreadBanner count={56} onJump={onJump} onMarkRead={onMarkRead} />);
    expect(screen.getByTestId('unread-banner')).toHaveTextContent('56 new messages');
    fireEvent.click(screen.getByTestId('unread-banner-jump'));
    fireEvent.click(screen.getByTestId('unread-banner-mark-read'));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it('the pill points down to what arrived below', () => {
    const onClick = vi.fn();
    render(<NewBelowPill count={2} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '2 new messages' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
