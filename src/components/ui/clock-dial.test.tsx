import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ClockDial } from './clock-dial';
import type { ClockTime } from '@/lib/clock-time';

function Harness({ start, hourCycle, onEnter }: { start: ClockTime | null; hourCycle?: 12 | 24; onEnter?: () => void }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <ClockDial value={value} onChange={setValue} hourCycle={hourCycle} onEnter={onEnter} />
      <output data-testid="value">{value ? `${value.hour}:${value.minute}` : 'none'}</output>
    </>
  );
}

const value = () => screen.getByTestId('value').textContent;
const press = (id: string) => fireEvent.click(screen.getByTestId(id));
const hour = () => screen.getByTestId('time-dial-hour-input') as HTMLInputElement;
const minute = () => screen.getByTestId('time-dial-minute-input') as HTMLInputElement;
const typeInto = (input: HTMLInputElement, text: string) => {
  act(() => input.focus());
  fireEvent.change(input, { target: { value: text } });
};

// The numbers on the face are buttons for the keyboard (Tab, Enter); pointers
// go through to the face, which the browser tests drive.
describe('ClockDial', () => {
  it('picks the hour, turns to the minutes, and shows the time above', () => {
    render(<Harness start={{ hour: 9, minute: 0 }} />);
    expect(hour()).toHaveValue('9');
    expect(minute()).toHaveValue('00');
    expect(screen.getByTestId('time-dial-am')).toHaveAttribute('aria-pressed', 'true');
    press('time-dial-hour-4');
    expect(value()).toBe('4:0');
    press('time-dial-minute-35');
    expect(value()).toBe('4:35');
    expect(minute()).toHaveValue('35');
    // The hour above turns the face back to the hours: on focus, and on a
    // click while it's still focused.
    fireEvent.focus(hour());
    expect(screen.getByTestId('time-dial-hour-4')).toHaveAttribute('aria-pressed', 'true');
    press('time-dial-minute-input');
    fireEvent.click(hour());
    expect(screen.getByTestId('time-dial-hour-4')).toBeInTheDocument();
  });

  it('types the hour, moves on to the minutes, and types those', () => {
    render(<Harness start={{ hour: 14, minute: 0 }} />);
    // "1" could be 1, 10, 11 or 12: it stays on the hour…
    typeInto(hour(), '1');
    expect(value()).toBe('13:0');
    expect(document.activeElement).toBe(hour());
    // …"11" is a whole hour, kept in the afternoon: on to the minutes.
    fireEvent.change(hour(), { target: { value: '11' } });
    expect(value()).toBe('23:0');
    expect(document.activeElement).toBe(minute());
    fireEvent.change(minute(), { target: { value: '07' } });
    expect(value()).toBe('23:7');
    // A single digit past 1 can only be that hour.
    typeInto(hour(), '4');
    expect(value()).toBe('16:7');
    expect(document.activeElement).toBe(minute());
  });

  it('steps with the arrow keys, wrapping round, and switches AM and PM with a and p', () => {
    const onEnter = vi.fn();
    render(<Harness start={{ hour: 0, minute: 0 }} onEnter={onEnter} />);
    fireEvent.keyDown(hour(), { key: 'ArrowDown' });
    expect(value()).toBe('23:0');
    fireEvent.keyDown(minute(), { key: 'ArrowDown' });
    expect(value()).toBe('23:59');
    fireEvent.keyDown(minute(), { key: 'ArrowUp' });
    expect(value()).toBe('23:0');
    fireEvent.keyDown(hour(), { key: 'a' });
    expect(value()).toBe('11:0');
    fireEvent.keyDown(minute(), { key: 'p' });
    expect(value()).toBe('23:0');
    fireEvent.keyDown(minute(), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('switches AM and PM with its buttons, and offers the afternoon hours under PM', () => {
    render(<Harness start={{ hour: 9, minute: 15 }} />);
    press('time-dial-pm');
    expect(value()).toBe('21:15');
    expect(screen.getByTestId('time-dial-pm')).toHaveAttribute('aria-pressed', 'true');
    press('time-dial-hour-12');
    expect(value()).toBe('12:15');
    expect(hour()).toHaveValue('12');
    press('time-dial-am');
    expect(value()).toBe('0:15');
    expect(hour()).toHaveValue('12');
  });

  it('starts from midnight when no time is chosen yet, and Enter does nothing without a handler', () => {
    render(<Harness start={null} />);
    expect(hour()).toHaveValue('');
    expect(hour()).toHaveAttribute('placeholder', '--');
    expect(screen.getByTestId('time-dial-am')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('time-dial-pm')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('time-dial-hand')).toBeNull();
    fireEvent.keyDown(minute(), { key: 'Enter' });
    typeInto(minute(), '10');
    expect(value()).toBe('0:10');
    expect(screen.getByTestId('time-dial-hand')).toBeInTheDocument();
  });

  it('puts 13–00 on an inner ring on a 24-hour clock, typed as 0–23, with no AM or PM', () => {
    render(<Harness start={{ hour: 0, minute: 5 }} hourCycle={24} />);
    expect(screen.queryByTestId('time-dial-am')).toBeNull();
    expect(hour()).toHaveValue('00');
    expect(screen.getByTestId('time-dial-hour-0')).toHaveAttribute('aria-label', '00 hours');
    press('time-dial-hour-18');
    expect(value()).toBe('18:5');
    fireEvent.focus(hour());
    press('time-dial-hour-12');
    expect(value()).toBe('12:5');
    // "2" could still be 20–23; "3" can only be 3.
    typeInto(hour(), '2');
    expect(value()).toBe('2:5');
    expect(document.activeElement).toBe(hour());
    typeInto(hour(), '3');
    expect(document.activeElement).toBe(minute());
    typeInto(hour(), '24');
    expect(value()).toBe('3:5');
    // a and p mean nothing on a 24-hour clock.
    fireEvent.keyDown(hour(), { key: 'p' });
    expect(value()).toBe('3:5');
  });

  it('ignores a pointer it did not see go down', () => {
    const onChange = vi.fn();
    render(<ClockDial value={{ hour: 1, minute: 0 }} onChange={onChange} />);
    const face = screen.getByTestId('time-dial-face');
    fireEvent.pointerMove(face);
    fireEvent.pointerUp(face);
    expect(onChange).not.toHaveBeenCalled();
  });
});
