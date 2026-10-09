import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useKeyboardInset, useKeyboardInsetTracker } from './useKeyboardInset';

function Probe() {
  useKeyboardInsetTracker();
  const inset = useKeyboardInset();
  return <span data-testid="inset">{inset}</span>;
}

function keyboard(type: string, height?: number, viaDetail = false) {
  const ev = viaDetail
    ? new CustomEvent(type, { detail: { keyboardHeight: height } })
    : Object.assign(new Event(type), height === undefined ? {} : { keyboardHeight: height });
  act(() => {
    window.dispatchEvent(ev);
  });
}

describe('useKeyboardInset', () => {
  let scrollY = 0;
  const scrollTo = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    // An earlier test's last glide may have ended under different timers.
    delete document.documentElement.dataset.keyboardSettling;
    scrollY = 0;
    scrollTo.mockReset();
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('follows the native keyboard height and resets when it hides', () => {
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    keyboard('keyboardWillShow', 320);
    expect(screen.getByTestId('inset')).toHaveTextContent('320');
    expect(document.documentElement.style.getPropertyValue('--ex-keyboard-inset')).toBe('320px');
    keyboard('keyboardDidShow', 320, true);
    expect(screen.getByTestId('inset')).toHaveTextContent('320');
    keyboard('keyboardWillHide');
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    keyboard('keyboardDidShow');
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    keyboard('keyboardDidHide');
    unmount();
  });

  // The app root animates its height only while the keyboard moves — never on
  // a window resize, which used to make the whole app trail the window edge.
  it('marks the document as settling only while the keyboard inset changes', () => {
    render(<Probe />);
    const root = document.documentElement;
    expect(root.dataset.keyboardSettling).toBeUndefined();
    keyboard('keyboardWillShow', 300);
    expect(root.dataset.keyboardSettling).toBe('true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(root.dataset.keyboardSettling).toBeUndefined();
    // A resize that doesn't change the inset doesn't start a glide.
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(root.dataset.keyboardSettling).toBeUndefined();
    keyboard('keyboardWillHide');
    expect(root.dataset.keyboardSettling).toBe('true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(root.dataset.keyboardSettling).toBeUndefined();
  });

  it('counts only what the keyboard still overlaps when the shell resized the window', () => {
    const inner = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    render(<Probe />);
    keyboard('keyboardWillShow', 300);
    inner.mockReturnValue(600);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('inset')).toHaveTextContent('100');
  });

  it('eases a panned page back to the top and brings the field into view in its scroller', () => {
    render(
      <div style={{ overflowY: 'auto' }} data-testid="scroller">
        <input aria-label="field" />
      </div>,
    );
    const scroller = screen.getByTestId('scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    const field = screen.getByLabelText('field');
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    field.focus();
    render(<Probe />);
    scrollY = 120;
    keyboard('keyboardWillShow', 300);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    // Scroll events during the glide are ours.
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    // A later pan (iOS again) settles again; at the top, nothing to do.
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(scrollTo).toHaveBeenCalledTimes(3);
    scrollY = 0;
    act(() => {
      vi.advanceTimersByTime(300);
      window.dispatchEvent(new Event('scroll'));
    });
    expect(scrollTo).toHaveBeenCalledTimes(3);
  });

  it('leaves a field without a scroller alone', () => {
    render(<input aria-label="plain" />);
    const field = screen.getByLabelText('plain');
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    field.focus();
    render(<Probe />);
    keyboard('keyboardWillShow', 250);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    // Keyboard down while nothing is focused: no field to reveal.
    field.blur();
    keyboard('keyboardWillHide');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('uses the visual viewport in a mobile browser, but not when pinch-zoomed', () => {
    const vv = Object.assign(new EventTarget(), { height: 500, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    try {
      const { unmount } = render(<Probe />);
      act(() => {
        vv.dispatchEvent(new Event('resize'));
      });
      expect(screen.getByTestId('inset')).toHaveTextContent('300');
      vv.scale = 2;
      act(() => {
        vv.dispatchEvent(new Event('resize'));
      });
      expect(screen.getByTestId('inset')).toHaveTextContent('0');
      unmount();
    } finally {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    }
  });
});
