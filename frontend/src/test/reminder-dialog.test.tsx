import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReminderDialog } from '@/components/chat/ReminderDialog';

function setup(initialValue: string, onConfirm = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <ReminderDialog open initialValue={initialValue} onConfirm={onConfirm} onOpenChange={onOpenChange} />,
  );
  return { onConfirm, onOpenChange };
}

describe('ReminderDialog', () => {
  it('confirms a future time and closes', () => {
    const future = '2999-01-01T09:00';
    const { onConfirm, onOpenChange } = setup(future);
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((onConfirm.mock.calls[0][0] as Date).getFullYear()).toBe(2999);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('rejects a past time with an inline error and does not confirm', () => {
    const { onConfirm } = setup('2000-01-01T09:00');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('rejects an empty/invalid time', () => {
    const { onConfirm } = setup('');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('edits the field then confirms the edited value', () => {
    const { onConfirm } = setup('2999-01-01T09:00');
    fireEvent.change(screen.getByTestId('reminder-datetime'), { target: { value: '2999-02-02T10:30' } });
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    const when = onConfirm.mock.calls[0][0] as Date;
    expect(when.getMonth()).toBe(1); // February
  });

  it('cancels without confirming', () => {
    const { onConfirm, onOpenChange } = setup('2999-01-01T09:00');
    fireEvent.click(screen.getByTestId('reminder-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
