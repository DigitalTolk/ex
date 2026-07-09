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

  it('rejects an empty/invalid time', () => {
    const { onConfirm } = setup('');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('edits the field then confirms the edited value', async () => {
    const { onConfirm } = setup('2999-01-01T09:00');
    fireEvent.change(screen.getByTestId('reminder-datetime'), { target: { value: '2999-02-02T10:30' } });
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const when = onConfirm.mock.calls[0][0] as Date;
    expect(when.getMonth()).toBe(1); // February
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
