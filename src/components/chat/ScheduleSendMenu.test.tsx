import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ScheduleSendMenu } from './ScheduleSendMenu';

vi.mock('@/components/ui/dropdown-menu');

describe('ScheduleSendMenu', () => {
  it('opens on click (the composer toolbar swallows the press) and reports it', () => {
    const onOpenChange = vi.fn();
    render(<ScheduleSendMenu disabled={false} onSchedule={vi.fn()} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId('schedule-send-trigger'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Without a listener it still works.
    render(<ScheduleSendMenu disabled={false} onSchedule={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId('schedule-send-trigger')[1]);
  });

  it('a custom time opens the picker, worded for scheduling, and schedules for it', async () => {
    const onSchedule = vi.fn().mockResolvedValue(undefined);
    render(<ScheduleSendMenu disabled={false} onSchedule={onSchedule} />);
    fireEvent.click(screen.getByLabelText('Pick a custom time'));
    expect(screen.getByText('Choose when to send this message.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Send time'), { target: { value: '2099-01-02T08:30' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    });
    expect(onSchedule).toHaveBeenCalledWith(new Date('2099-01-02T08:30'));
    // Closing the picker forgets it.
    fireEvent.click(screen.getByLabelText('Pick a custom time'));
    fireEvent.click(screen.getByTestId('reminder-cancel'));
    expect(screen.queryByText('Choose when to send this message.')).toBeNull();
  });
});
