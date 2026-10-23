import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Own file: counts how often the dialog's module is loaded, which needs a
// module graph no other test has touched.

const dialogModule = vi.hoisted(() => ({ loads: 0 }));

vi.mock('@/components/chat/ReminderDialog', async (importOriginal) => {
  dialogModule.loads++;
  return importOriginal();
});
vi.mock('@/components/ui/dropdown-menu');

describe('ReminderDialog loading', () => {
  it('stays out of the message row, composer and Activity modules until a picker opens', async () => {
    // The dialog carries the date picker (react-day-picker + date-fns); every
    // one of these imported it eagerly, so it shipped in the boot bundle.
    await import('@/components/chat/MessageItem');
    await import('@/components/activity/ActivityPanel');
    const { ScheduleSendMenu } = await import('@/components/chat/ScheduleSendMenu');
    expect(dialogModule.loads).toBe(0);

    render(<ScheduleSendMenu disabled={false} onSchedule={vi.fn().mockResolvedValue(undefined)} />);
    expect(dialogModule.loads).toBe(0);

    fireEvent.click(screen.getByLabelText('Pick a custom time'));
    expect(await screen.findByRole('heading', { name: 'Schedule message' })).toBeInTheDocument();
    expect(dialogModule.loads).toBe(1);

    fireEvent.click(screen.getByTestId('reminder-cancel'));
    expect(screen.queryByRole('heading', { name: 'Schedule message' })).toBeNull();
    // Opening it again is immediate: the module is already there.
    fireEvent.click(screen.getByLabelText('Pick a custom time'));
    expect(screen.getByRole('heading', { name: 'Schedule message' })).toBeInTheDocument();
  });
});
