import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NewBelowPill, UnreadBanner, UnreadDivider } from './UnreadMarkers';

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
  });

  it('fades 3s after it comes into view, then reports it', () => {
    vi.useFakeTimers();
    installIntersectionObserver();
    const onSeen = vi.fn();
    render(<UnreadDivider onSeen={onSeen} />);
    expect(observers).toHaveLength(1);
    const line = screen.getByTestId('unread-divider');
    // Not on screen yet: nothing starts.
    act(() => observers[0].cb([{ isIntersecting: false }]));
    act(() => vi.advanceTimersByTime(4000));
    expect(line.className).not.toContain('opacity-0');
    expect(onSeen).not.toHaveBeenCalled();
    // On screen: the observer lets go, the fade starts after 3s and the
    // owner hears about it once the fade has run.
    act(() => observers[0].cb([{ isIntersecting: true }]));
    expect(observers[0].disconnected).toBe(true);
    act(() => vi.advanceTimersByTime(2999));
    expect(line.className).not.toContain('opacity-0');
    act(() => vi.advanceTimersByTime(1));
    expect(line.className).toContain('opacity-0');
    expect(onSeen).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it('a second sighting while the timer runs is ignored, and unmounting cancels the timers', () => {
    vi.useFakeTimers();
    installIntersectionObserver();
    const onSeen = vi.fn();
    const { unmount } = render(<UnreadDivider onSeen={onSeen} />);
    act(() => observers[0].cb([{ isIntersecting: true }]));
    act(() => observers[0].cb([{ isIntersecting: true }]));
    act(() => vi.advanceTimersByTime(3000));
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
