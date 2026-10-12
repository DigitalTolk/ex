import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TimePicker, timeSlots } from './time-picker';

describe('TimePicker', () => {
  it('lists every quarter hour, marks the chosen one, and picks on click', () => {
    const onChange = vi.fn();
    render(<TimePicker value={{ hour: 14, minute: 30 }} onChange={onChange} />);
    expect(timeSlots(15)).toHaveLength(96);
    expect(screen.getByTestId('time-slot-14-30')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('time-slot-14-30')).toHaveTextContent(/2:30 PM/);
    fireEvent.click(screen.getByTestId('time-slot-9-0'));
    expect(onChange).toHaveBeenCalledWith({ hour: 9, minute: 0 });
  });

  it('an in-between time highlights nothing but marks the nearest earlier row; no value marks nothing', () => {
    const { rerender } = render(<TimePicker value={{ hour: 9, minute: 7 }} onChange={vi.fn()} />);
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
    const classes = () => screen.getByTestId('time-slot-9-0').className.split(' ');
    expect(classes()).toContain('bg-muted');
    rerender(<TimePicker value={null} onChange={vi.fn()} />);
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
    expect(classes()).not.toContain('bg-muted');
  });

  it('24-hour clocks and other steps', () => {
    render(<TimePicker value={{ hour: 13, minute: 0 }} onChange={vi.fn()} hourCycle={24} stepMinutes={30} testIdPrefix="t" />);
    expect(screen.getByTestId('t-slot-13-0')).toHaveTextContent(/13:00/);
    expect(screen.queryByTestId('t-slot-13-15')).toBeNull();
  });
});
