import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { KEYBOARD_SETTLE_MS, useKeyboardInset, useKeyboardInsetTracker } from './useKeyboardInset';

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

  const appHeight = () => document.documentElement.style.getPropertyValue('--ex-app-height');

  it('follows the native keyboard height and resets when it hides', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    expect(appHeight()).toBe('');
    keyboard('keyboardWillShow', 320);
    expect(screen.getByTestId('inset')).toHaveTextContent('320');
    // The root gets exactly what's left above the keyboard, in px.
    expect(appHeight()).toBe('480px');
    keyboard('keyboardDidShow', 320, true);
    expect(screen.getByTestId('inset')).toHaveTextContent('320');
    keyboard('keyboardWillHide');
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    expect(appHeight()).toBe('');
    keyboard('keyboardDidShow');
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    keyboard('keyboardDidHide');
    unmount();
  });

  // The app root animates its height only while the keyboard comes or goes —
  // never on a window resize, which used to make the whole app trail the
  // window edge, nor on the suggestion bar changing height while typing.
  it('marks the document as settling only while the keyboard comes or goes', () => {
    render(<Probe />);
    const root = document.documentElement;
    expect(root.dataset.keyboardSettling).toBeUndefined();
    keyboard('keyboardWillShow', 300);
    expect(root.dataset.keyboardSettling).toBe('true');
    // The CSS transition takes its duration from the same constant as the timer.
    expect(root.style.getPropertyValue('--ex-keyboard-settle')).toBe(`${KEYBOARD_SETTLE_MS}ms`);
    act(() => {
      vi.advanceTimersByTime(KEYBOARD_SETTLE_MS);
    });
    expect(root.dataset.keyboardSettling).toBeUndefined();
    // A resize that doesn't change the inset doesn't start a glide, and nor
    // does a keyboard that changes height while it stays up.
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(root.dataset.keyboardSettling).toBeUndefined();
    keyboard('keyboardDidShow', 340);
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
    expect(appHeight()).toBe('500px');
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
    // The keyboard's pan landing late (iOS again) settles again; at the top,
    // nothing to do.
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

  // The reported bug: on iOS every character typed made the composer jump.
  // While typing, iOS pans the page a little to keep the caret in view, and
  // each pan was answered with a smooth scroll back to the top (and, in a
  // scroller such as a /threads card, a scroll of the field into view) —
  // which moved the caret, so the next character panned again.
  it('never scrolls the page back while typing once the keyboard is up', () => {
    render(
      <div style={{ overflowY: 'auto' }} data-testid="scroller">
        <input aria-label="composer" />
      </div>,
    );
    const scroller = screen.getByTestId('scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    const field = screen.getByLabelText('composer');
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    field.focus();
    render(<Probe />);
    keyboard('keyboardWillShow', 300);
    act(() => {
      vi.advanceTimersByTime(2000); // the keyboard is up and has settled
    });
    scrollTo.mockClear();
    scrollIntoView.mockClear();

    // Each keystroke: iOS pans to reveal the caret.
    for (let key = 0; key < 5; key++) {
      scrollY = 12 * (key + 1);
      act(() => {
        window.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(100);
      });
    }

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  // Sized from the very viewport the keyboard is measured against: a root
  // even a few px taller than what's visible puts the caret under the
  // keyboard, and iOS pans for it on every keystroke.
  it('sizes the root to exactly what a mobile browser shows above the keyboard', () => {
    const vv = Object.assign(new EventTarget(), { height: 500, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    try {
      const { unmount } = render(<Probe />);
      act(() => {
        vv.dispatchEvent(new Event('resize'));
      });
      expect(appHeight()).toBe('500px');
      act(() => {
        vi.advanceTimersByTime(KEYBOARD_SETTLE_MS);
      });
      // The suggestion bar coming up while typing: the root follows at once,
      // without a glide or a scroll.
      scrollTo.mockClear();
      vv.height = 460;
      act(() => {
        vv.dispatchEvent(new Event('resize'));
      });
      expect(appHeight()).toBe('460px');
      expect(document.documentElement.dataset.keyboardSettling).toBeUndefined();
      expect(scrollTo).not.toHaveBeenCalled();
      unmount();
      expect(appHeight()).toBe('');
    } finally {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    }
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
