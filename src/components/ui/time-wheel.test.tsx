import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TimeWheel } from './time-wheel';

const ROW = 48;
// The middle copy of each wheel's track, where it rests: the hours' 71 and
// the minutes' 15 copies run 20,000px either way.
const H = 35;
const M = 7;
const wheel = (part: string) => screen.getByTestId(`t-wheel-${part}`);
const shows = (part: string) => wheel(part).getAttribute('aria-valuetext');
const period = () => shows('period');

function setup(value: { hour: number; minute: number } | null, extra: { hourCycle?: 12 | 24; onEnter?: () => void } = {}) {
  const onChange = vi.fn();
  const view = render(<TimeWheel value={value} onChange={onChange} testIdPrefix="t" {...extra} />);
  return { onChange, ...view };
}

// The browser saying a wheel's scrolling has stopped.
const stop = (el: HTMLElement) => act(() => void el.dispatchEvent(new Event('scrollend')));

// Scrolls a wheel to `row` (of its whole track) and lets it stop there.
function spinTo(part: string, row: number) {
  const el = wheel(part);
  el.scrollTop = row * ROW;
  fireEvent.scroll(el);
  stop(el);
}

afterEach(() => vi.useRealTimers());

describe('TimeWheel', () => {
  it('opens on the time, each wheel at its value in the middle of its rows', () => {
    setup({ hour: 21, minute: 5 });
    expect([shows('hour'), shows('minute'), period()]).toEqual(['9', '05', 'PM']);
    // The wheels rest in the middle of their tracks.
    expect(wheel('hour').scrollTop).toBe((H * 12 + 8) * ROW);
    expect(wheel('minute').scrollTop).toBe((M * 60 + 5) * ROW);
  });

  // The track runs further either way than any fling: one to the far end
  // still settles there, and comes back to the middle to go round again.
  it('goes round however far a fling takes it', () => {
    vi.useFakeTimers();
    const { onChange } = setup({ hour: 9, minute: 30 });
    spinTo('minute', (M + 7) * 60 + 12);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 12 });
    expect(wheel('minute').scrollTop).toBe((M * 60 + 12) * ROW);
  });

  // Only a window of rows is rendered, moved along every ten rows a spin
  // goes — so the rows ahead are always there, and it doesn't re-render row
  // by row.
  it('renders a window of rows that moves along with a spin', () => {
    vi.useFakeTimers();
    setup({ hour: 9, minute: 30 });
    const el = wheel('minute');
    const rendered = () => Array.from(el.querySelectorAll('[data-row]'), (r) => r.textContent);
    expect(rendered()).toHaveLength(61);
    expect([rendered()[0], rendered()[60]]).toEqual(['00', '00']);
    // The rows above and below stand in as space: the track is all there.
    expect((el.firstElementChild as HTMLElement).style.height).toBe(`${(M * 60) * ROW}px`);
    // Eight rows on, the window stays put; twelve, and it has moved along.
    el.scrollTop = (M * 60 + 38) * ROW;
    fireEvent.scroll(el);
    expect(rendered()[0]).toBe('00');
    el.scrollTop = (M * 60 + 42) * ROW;
    fireEvent.scroll(el);
    expect([rendered()[0], rendered()[60]]).toEqual(['12', '12']);
  });

  it('shows 12 AM with nothing chosen, and chooses nothing until a wheel moves', () => {
    vi.useFakeTimers();
    const { onChange } = setup(null);
    expect([shows('hour'), shows('minute'), period()]).toEqual(['12', '00', 'AM']);
    spinTo('minute', M * 60);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('turns to a tapped row and ignores a tap on the chosen one', () => {
    const { onChange } = setup({ hour: 9, minute: 0 });
    fireEvent.click(screen.getByTestId('t-wheel-minute-3'));
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 3 });
    expect(wheel('minute').scrollTop).toBe((M * 60 + 3) * ROW);
    // The nearest :57 is three rows up, not 57 down.
    fireEvent.click(screen.getByTestId('t-wheel-minute-57'));
    expect(wheel('minute').scrollTop).toBe((M * 60 - 3) * ROW);
    fireEvent.click(screen.getByTestId('t-wheel-hour-4'));
    expect(onChange).toHaveBeenLastCalledWith({ hour: 4, minute: 0 });
    fireEvent.click(screen.getByTestId('t-wheel-pm'));
    expect(onChange).toHaveBeenLastCalledWith({ hour: 21, minute: 0 });
    onChange.mockClear();
    fireEvent.click(screen.getByTestId('t-wheel-hour-9'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('settles on the row a spin stops at, back in the middle copy', () => {
    vi.useFakeTimers();
    const { onChange } = setup({ hour: 9, minute: 58 });
    // On past :59 into the next copy, to :01.
    spinTo('minute', (M + 1) * 60 + 1);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 1 });
    expect(wheel('minute').scrollTop).toBe((M * 60 + 1) * ROW);
    // Stopped between rows, it eases onto the nearest before it counts.
    onChange.mockClear();
    const el = wheel('hour');
    el.scrollTop = (H * 12 + 3) * ROW + 20;
    stop(el);
    expect(onChange).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe((H * 12 + 3) * ROW);
    stop(el);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 4, minute: 58 });
  });

  it('turns to a time set from outside, the short way round', () => {
    const { rerender } = setup({ hour: 9, minute: 58 });
    rerender(<TimeWheel value={{ hour: 9, minute: 2 }} onChange={vi.fn()} testIdPrefix="t" />);
    expect(wheel('minute').scrollTop).toBe(((M + 1) * 60 + 2) * ROW);
    rerender(<TimeWheel value={{ hour: 9, minute: 55 }} onChange={vi.fn()} testIdPrefix="t" />);
    expect(wheel('minute').scrollTop).toBe((M * 60 + 55) * ROW);
  });

  it('steps with the arrow keys, going round on the hours and minutes but not AM/PM', () => {
    const { onChange } = setup({ hour: 12, minute: 59 });
    fireEvent.keyDown(wheel('minute'), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 12, minute: 0 });
    fireEvent.keyDown(wheel('hour'), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 23, minute: 59 });
    fireEvent.keyDown(wheel('period'), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 0, minute: 59 });
    onChange.mockClear();
    fireEvent.keyDown(wheel('period'), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 12, minute: 59 });
  });

  it('spins AM/PM like the others, without going round', () => {
    vi.useFakeTimers();
    const { onChange, rerender } = setup({ hour: 9, minute: 0 });
    expect(wheel('period').scrollTop).toBe(0);
    spinTo('period', 1);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 21, minute: 0 });
    expect(wheel('period').scrollTop).toBe(ROW);
    // Turned from outside, it goes straight there.
    rerender(<TimeWheel value={{ hour: 21, minute: 0 }} onChange={onChange} testIdPrefix="t" />);
    rerender(<TimeWheel value={{ hour: 9, minute: 0 }} onChange={onChange} testIdPrefix="t" />);
    expect(wheel('period').scrollTop).toBe(0);
  });

  it('picks typed digits, adding up ones typed close together', () => {
    vi.useFakeTimers();
    const { onChange } = setup({ hour: 9, minute: 0 });
    fireEvent.keyDown(wheel('minute'), { key: '4' });
    fireEvent.keyDown(wheel('minute'), { key: '5' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 45 });
    // "99" is no minute: it starts again from the last 9.
    fireEvent.keyDown(wheel('minute'), { key: '9' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 9 });
    // A pause starts a new value.
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.keyDown(wheel('minute'), { key: '7' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 7 });
    // A 12-hour clock has no hour 0.
    onChange.mockClear();
    fireEvent.keyDown(wheel('hour'), { key: '0' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(wheel('hour'), { key: 'x' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('switches AM and PM with a and p, and confirms with Enter', () => {
    const onEnter = vi.fn();
    const { onChange } = setup({ hour: 9, minute: 15 }, { onEnter });
    fireEvent.keyDown(wheel('minute'), { key: 'p' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 21, minute: 15 });
    fireEvent.keyDown(wheel('hour'), { key: 'a' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 15 });
    fireEvent.keyDown(wheel('period'), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('has 00–23 and no AM/PM on a 24-hour clock', () => {
    const { onChange } = setup({ hour: 7, minute: 0 }, { hourCycle: 24 });
    expect(screen.queryByTestId('t-wheel-period')).toBeNull();
    expect(shows('hour')).toBe('07');
    fireEvent.click(screen.getByTestId('t-wheel-hour-10'));
    expect(onChange).toHaveBeenLastCalledWith({ hour: 10, minute: 0 });
    fireEvent.keyDown(wheel('hour'), { key: '2' });
    fireEvent.keyDown(wheel('hour'), { key: '3' });
    expect(onChange).toHaveBeenLastCalledWith({ hour: 23, minute: 0 });
    // a/p mean nothing here; Enter without a dialog to confirm does nothing.
    onChange.mockClear();
    fireEvent.keyDown(wheel('hour'), { key: 'p' });
    fireEvent.keyDown(wheel('hour'), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  // Touch, trackpads and mouse wheels scroll the wheels natively; a mouse can
  // also drag them, its release no tap on a row.
  it('follows a mouse drag, flings on, and takes no tap from the release', () => {
    vi.useFakeTimers();
    const { onChange } = setup({ hour: 9, minute: 0 });
    const el = wheel('minute');
    const at = el.scrollTop;
    // Touch and other buttons scroll natively.
    fireEvent.pointerDown(el, { pointerType: 'touch', clientY: 100 });
    fireEvent.pointerDown(el, { pointerType: 'mouse', button: 2, clientY: 100 });
    fireEvent.pointerMove(el, { clientY: 0 });
    fireEvent.pointerUp(el);
    expect(el.scrollTop).toBe(at);
    fireEvent.pointerDown(el, { pointerType: 'mouse', button: 0, clientY: 300, timeStamp: 0 });
    // A wobble is no drag.
    fireEvent.pointerMove(el, { clientY: 297, timeStamp: 50 });
    expect(el.scrollTop).toBe(at);
    fireEvent.pointerMove(el, { clientY: 300 - 2 * ROW, timeStamp: 100 });
    expect(el.scrollTop).toBe(at + 2 * ROW);
    // Still held, it doesn't settle.
    stop(el);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(el);
    fireEvent.click(screen.getByTestId('t-wheel-minute-1'));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(0));
    // Released on the move, it settles a row or so on.
    stop(el);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: el.scrollTop / ROW - M * 60 });
    // A press that doesn't move is a tap.
    fireEvent.pointerDown(el, { pointerType: 'mouse', button: 0, clientY: 50 });
    fireEvent.pointerCancel(el);
    fireEvent.click(screen.getByTestId('t-wheel-minute-5'));
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 5 });
  });

  // A browser without scrollend (older Safari): the stop is the first quiet
  // moment after the scrolling, and a wheel closed before it takes nothing.
  describe('without scrollend', () => {
    let owner: object;
    let onscrollend: PropertyDescriptor;
    beforeEach(() => {
      owner = window;
      while (!Object.prototype.hasOwnProperty.call(owner, 'onscrollend')) owner = Object.getPrototypeOf(owner);
      onscrollend = Object.getOwnPropertyDescriptor(owner, 'onscrollend')!;
      delete (owner as { onscrollend?: unknown }).onscrollend;
      vi.useFakeTimers();
    });
    afterEach(() => Object.defineProperty(owner, 'onscrollend', onscrollend));

    it('takes the value once the scrolling has gone quiet', () => {
      const { onChange } = setup({ hour: 9, minute: 0 });
      const el = wheel('minute');
      el.scrollTop = (M * 60 + 10) * ROW;
      fireEvent.scroll(el);
      act(() => vi.advanceTimersByTime(60));
      fireEvent.scroll(el);
      act(() => vi.advanceTimersByTime(60));
      expect(onChange).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(100));
      expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 10 });
    });

    it('lets a spin go when it closes before stopping', () => {
      const { onChange, unmount } = setup({ hour: 9, minute: 0 });
      const el = wheel('minute');
      el.scrollTop = (M * 60 + 10) * ROW;
      fireEvent.scroll(el);
      unmount();
      act(() => vi.advanceTimersByTime(200));
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
