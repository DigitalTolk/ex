import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ClockDial } from './clock-dial';
import type { ClockTime } from '@/lib/clock-time';

function Harness({ start, hourCycle }: { start: ClockTime | null; hourCycle?: 12 | 24 }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <ClockDial value={value} onChange={setValue} hourCycle={hourCycle} />
      <output data-testid="value">{value ? `${value.hour}:${value.minute}` : 'none'}</output>
    </>
  );
}

const value = () => screen.getByTestId('value').textContent;
const press = (id: string) => fireEvent.click(screen.getByTestId(id));

// The numbers are buttons for the keyboard (Tab, Enter); pointers go through
// to the face, which the browser tests drive.
describe('ClockDial', () => {
  it('picks the hour, turns to the minutes, and reads the time back', () => {
    render(<Harness start={{ hour: 9, minute: 0 }} />);
    expect(screen.getByTestId('time-dial-mode-hour')).toHaveTextContent('9');
    expect(screen.getByTestId('time-dial-am')).toHaveAttribute('aria-pressed', 'true');
    press('time-dial-hour-4');
    expect(value()).toBe('4:0');
    expect(screen.getByTestId('time-dial-mode-minute')).toHaveAttribute('aria-pressed', 'true');
    press('time-dial-minute-35');
    expect(value()).toBe('4:35');
    expect(screen.getByTestId('time-dial-mode-minute')).toHaveTextContent('35');
    // Back to the hours from the header.
    press('time-dial-mode-hour');
    expect(screen.getByTestId('time-dial-hour-4')).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches AM and PM, and offers the afternoon hours under PM', () => {
    render(<Harness start={{ hour: 9, minute: 15 }} />);
    press('time-dial-pm');
    expect(value()).toBe('21:15');
    expect(screen.getByTestId('time-dial-pm')).toHaveAttribute('aria-pressed', 'true');
    press('time-dial-hour-12');
    expect(value()).toBe('12:15');
    expect(screen.getByTestId('time-dial-mode-hour')).toHaveTextContent('12');
    press('time-dial-mode-hour');
    press('time-dial-am');
    expect(value()).toBe('0:15');
    expect(screen.getByTestId('time-dial-mode-hour')).toHaveTextContent('12');
  });

  it('starts from midnight when no time is chosen yet', () => {
    render(<Harness start={null} />);
    expect(screen.getByTestId('time-dial-mode-hour')).toHaveTextContent('--');
    expect(screen.getByTestId('time-dial-mode-minute')).toHaveTextContent('--');
    expect(screen.getByTestId('time-dial-am')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('time-dial-pm')).toHaveAttribute('aria-pressed', 'false');
    press('time-dial-mode-minute');
    press('time-dial-minute-10');
    expect(value()).toBe('0:10');
  });

  it('puts 13–00 on an inner ring on a 24-hour clock, with no AM or PM', () => {
    render(<Harness start={{ hour: 0, minute: 5 }} hourCycle={24} />);
    expect(screen.queryByTestId('time-dial-am')).toBeNull();
    expect(screen.getByTestId('time-dial-mode-hour')).toHaveTextContent('00');
    expect(screen.getByTestId('time-dial-hour-0')).toHaveAttribute('aria-label', '00 hours');
    press('time-dial-hour-18');
    expect(value()).toBe('18:5');
    press('time-dial-mode-hour');
    press('time-dial-hour-12');
    expect(value()).toBe('12:5');
    expect(screen.getByTestId('time-dial-mode-hour')).toHaveTextContent('12');
  });

  it('ignores a pointer it did not see go down', () => {
    const onChange = vi.fn();
    render(<ClockDial value={{ hour: 1, minute: 0 }} onChange={onChange} />);
    const face = screen.getByTestId('time-dial-face');
    fireEvent.pointerMove(face);
    fireEvent.pointerUp(face);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('time-dial-mode-hour')).toHaveAttribute('aria-pressed', 'true');
  });
});
