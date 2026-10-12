import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReminderDialog } from '@/components/chat/ReminderDialog';

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));

beforeEach(() => {
  mockIsMobile = false;
});

function setup(
  initialValue: string,
  onConfirm: (when: Date) => Promise<void> = vi.fn(() => Promise.resolve()),
  onOpenChange = vi.fn(),
) {
  render(
    <ReminderDialog open initialValue={initialValue} onConfirm={onConfirm} onOpenChange={onOpenChange} />,
  );
  return { onConfirm: onConfirm as ReturnType<typeof vi.fn>, onOpenChange };
}

describe('ReminderDialog', () => {
  it('confirms a future time and closes on success', async () => {
    const future = '2999-01-01T09:00';
    const { onConfirm, onOpenChange } = setup(future);
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((onConfirm.mock.calls[0][0] as Date).getFullYear()).toBe(2999);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open and surfaces an error when scheduling fails', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('boom')));
    const { onOpenChange } = setup('2999-01-01T09:00', failing);
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(await screen.findByTestId('reminder-error')).toHaveTextContent("Couldn't set the reminder");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('rejects a past time with an inline error and does not confirm', () => {
    const { onConfirm } = setup('2000-01-01T09:00');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('rejects an empty seed: no time, then no date', () => {
    const { onConfirm } = setup('');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toHaveTextContent('Enter a time');
    fireEvent.change(screen.getByTestId('reminder-time'), { target: { value: '9:30' } });
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toHaveTextContent('Pick a date');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('picks a day on the calendar and a typed time, previews the result, then confirms it', async () => {
    const { onConfirm } = setup('2999-01-01T09:00');
    expect(screen.queryByTestId('reminder-preview')).toBeNull();
    // The calendar opens on the seed's month.
    fireEvent.click(screen.getByTestId('reminder-day-2999-01-15'));
    // Typed loosely; the preview reads it back and the field tidies on blur.
    fireEvent.change(screen.getByTestId('reminder-time'), { target: { value: '1030' } });
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/^Reminds you .*10:30/);
    fireEvent.blur(screen.getByTestId('reminder-time'));
    expect((screen.getByTestId('reminder-time') as HTMLInputElement).value).toMatch(/10:30/);
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const when = onConfirm.mock.calls[0][0] as Date;
    expect([when.getMonth(), when.getDate(), when.getHours(), when.getMinutes()]).toEqual([0, 15, 10, 30]);
  });

  it('the time list sets the field, and arrow keys nudge it a quarter hour', () => {
    setup('2999-01-01T09:00');
    expect(screen.getByTestId('reminder-slot-9-0')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('reminder-slot-14-15'));
    expect((screen.getByTestId('reminder-time') as HTMLInputElement).value).toMatch(/2:15 PM/);
    expect(screen.getByTestId('reminder-slot-14-15')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/2:15 PM/);
    fireEvent.keyDown(screen.getByTestId('reminder-time'), { key: 'ArrowDown' });
    expect((screen.getByTestId('reminder-time') as HTMLInputElement).value).toMatch(/2:30 PM/);
    fireEvent.keyDown(screen.getByTestId('reminder-time'), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByTestId('reminder-time'), { key: 'ArrowUp' });
    expect((screen.getByTestId('reminder-time') as HTMLInputElement).value).toMatch(/2:00 PM/);
    // Nothing to nudge while the field holds no time.
    fireEvent.change(screen.getByTestId('reminder-time'), { target: { value: 'soon' } });
    fireEvent.keyDown(screen.getByTestId('reminder-time'), { key: 'ArrowDown' });
    expect((screen.getByTestId('reminder-time') as HTMLInputElement).value).toBe('soon');
  });

  it('clicking the chosen day again clears the date, and the month can be paged', () => {
    const { onConfirm } = setup('2999-01-01T09:00');
    fireEvent.click(screen.getByTestId('reminder-day-2999-01-01'));
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toHaveTextContent('Pick a date');
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    expect(screen.getByTestId('reminder-day-2999-02-15')).toBeInTheDocument();
  });

  it('shows no preview for a time it cannot read, leaves it untouched on blur, and says so on confirm', () => {
    const { onConfirm } = setup('2999-01-01T09:00');
    fireEvent.change(screen.getByTestId('reminder-time'), { target: { value: 'soon' } });
    expect(screen.queryByTestId('reminder-preview')).toBeNull();
    fireEvent.blur(screen.getByTestId('reminder-time'));
    expect((screen.getByTestId('reminder-time') as HTMLInputElement).value).toBe('soon');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toHaveTextContent('Enter a time');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a quick pick fills both fields and the preview; Enter in the time field confirms', async () => {
    const { onConfirm } = setup('');
    fireEvent.click(screen.getByTestId('reminder-quick-tomorrow'));
    expect(document.querySelector('[data-testid^="reminder-day-"][data-selected-single="true"]')).not.toBeNull();
    expect((screen.getByTestId('reminder-time') as HTMLInputElement).value).toMatch(/9:00/);
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/^Reminds you Tomorrow at .*9:00/);
    fireEvent.keyDown(screen.getByTestId('reminder-time'), { key: 'a' });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('reminder-time'), { key: 'Enter' });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('shows no preview for a time already in the past', () => {
    setup('2000-01-01T09:00');
    fireEvent.change(screen.getByTestId('reminder-time'), { target: { value: '10:00' } });
    expect(screen.queryByTestId('reminder-preview')).toBeNull();
  });

  it('cancels without confirming', () => {
    const { onConfirm, onOpenChange } = setup('2999-01-01T09:00');
    fireEvent.click(screen.getByTestId('reminder-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe('mobile', () => {
    // On mobile the confirm moves to the dialog's top-right header — the iOS
    // date wheel covers the bottom half of the screen, hiding a footer button.
    function mobileAction(): HTMLButtonElement {
      const btn = document.querySelector('[data-slot="dialog-mobile-action"]');
      expect(btn).not.toBeNull();
      return btn as HTMLButtonElement;
    }

    it('moves Set reminder into the top header and drops the footer', () => {
      mockIsMobile = true;
      setup('2999-01-01T09:00');
      expect(mobileAction()).toHaveTextContent('Set reminder');
      expect(screen.queryByTestId('reminder-confirm')).not.toBeInTheDocument();
      expect(screen.queryByTestId('reminder-cancel')).not.toBeInTheDocument();
    });

    it('confirms via the header action and shows the pending label while in flight', async () => {
      mockIsMobile = true;
      let release: () => void = () => {};
      const slow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
      const { onOpenChange } = setup('2999-01-01T09:00', slow);
      fireEvent.click(mobileAction());
      expect(slow).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(mobileAction()).toHaveTextContent('Setting…'));
      expect(mobileAction()).toBeDisabled();
      release();
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });
  });
});
