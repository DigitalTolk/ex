import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReminderDialog } from '@/components/chat/ReminderDialog';
import { NOBODY_ELSE, type ReminderAudience } from '@/lib/reminder-audience';
import { wheelTo } from '@/test/wheel-time';

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

const wheel = (part: 'hour' | 'minute') => screen.getByTestId(`reminder-wheel-${part}`);

// Turns the wheels to a time (hour 0–23) by tapping their rows.
const turnTo = (hour: number, minute: number) => wheelTo(hour, minute, (el, key) => fireEvent.keyDown(el, { key }));

describe('ReminderDialog', () => {
  it('confirms a future time and closes on success', async () => {
    const future = '2999-01-01T09:00';
    const { onConfirm, onOpenChange } = setup(future);
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((onConfirm.mock.calls[0][0] as Date).getFullYear()).toBe(2999);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // Scheduled sends use the same dialog, with no note.
  it('has a note field only when asked for one, and passes it on trimmed', async () => {
    setup('2999-01-01T09:00');
    expect(screen.queryByTestId('reminder-note')).toBeNull();
    // Nor tabs without people to choose: a scheduled send is the time alone.
    expect(screen.queryByTestId('reminder-tab-who')).toBeNull();
    cleanup();

    const onConfirm = vi.fn((_when: Date, _audience: ReminderAudience, _note: string) => Promise.resolve());
    render(<ReminderDialog open initialValue="2999-01-01T09:00" onConfirm={onConfirm} onOpenChange={vi.fn()} note="" />);
    const note = screen.getByRole('textbox', { name: 'Reminder note' });
    expect(note).toHaveValue('');
    expect(note).toHaveAttribute('maxLength', '500');
    fireEvent.change(note, { target: { value: '  bring the Q3 numbers\n' } });
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.any(Date), NOBODY_ELSE, 'bring the Q3 numbers'));
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
    expect(screen.getByTestId('reminder-error')).toHaveTextContent('Pick a time.');
    turnTo(9, 30);
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toHaveTextContent('Pick a date');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('picks a day on the calendar and a time on the wheels, previews the result, then confirms it', async () => {
    const { onConfirm } = setup('2999-01-01T09:00');
    expect(screen.queryByTestId('reminder-preview')).toBeNull();
    // The calendar opens on the seed's month.
    fireEvent.click(screen.getByTestId('reminder-day-2999-01-15'));
    turnTo(10, 30);
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/^Reminds you .*10:30/);
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const when = onConfirm.mock.calls[0][0] as Date;
    expect([when.getMonth(), when.getDate(), when.getHours(), when.getMinutes()]).toEqual([0, 15, 10, 30]);
  });

  it('the wheels open on the seed, turn to a tapped row, and step with the arrow keys', () => {
    setup('2999-01-01T09:00');
    expect([wheel('hour'), wheel('minute')].map((w) => w.getAttribute('aria-valuetext'))).toEqual(['9', '00']);
    expect(screen.getByTestId('reminder-wheel-period')).toHaveAttribute('aria-valuetext', 'AM');
    turnTo(14, 15);
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/2:15 PM/);
    fireEvent.keyDown(wheel('minute'), { key: 'ArrowDown' });
    expect(wheel('minute')).toHaveAttribute('aria-valuetext', '14');
    fireEvent.keyDown(wheel('hour'), { key: 'ArrowUp' });
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/3:14 PM/);
    // Other keys pass through.
    fireEvent.keyDown(wheel('hour'), { key: 'x' });
    expect(wheel('hour')).toHaveAttribute('aria-valuetext', '3');
  });

  // Late in the evening the seed is already tomorrow, so tapping tomorrow is
  // tapping the chosen day. That used to clear the date and Set answered
  // "Pick a date." (and the reminder tests failed every night after 23:00).
  it('tapping the chosen day again keeps it chosen, and the month can be paged', async () => {
    const { onConfirm } = setup('2999-01-01T09:00');
    fireEvent.click(screen.getByTestId('reminder-day-2999-01-01'));
    expect(screen.getByTestId('reminder-day-2999-01-01')).toHaveAttribute('data-selected-single', 'true');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.queryByTestId('reminder-error')).toBeNull();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const when = onConfirm.mock.calls[0][0] as Date;
    expect([when.getFullYear(), when.getMonth(), when.getDate(), when.getHours()]).toEqual([2999, 0, 1, 9]);
    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    expect(screen.getByTestId('reminder-day-2999-02-15')).toBeInTheDocument();
  });

  it('a quick pick fills the day, the time and the preview; a and p switch AM and PM; Enter confirms', async () => {
    const { onConfirm } = setup('');
    fireEvent.click(screen.getByTestId('reminder-quick-tomorrow'));
    expect(document.querySelector('[data-testid^="reminder-day-"][data-selected-single="true"]')).not.toBeNull();
    expect([wheel('hour'), wheel('minute')].map((w) => w.getAttribute('aria-valuetext'))).toEqual(['9', '00']);
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/^Reminds you Tomorrow at .*9:00 AM/);
    fireEvent.keyDown(wheel('hour'), { key: 'p' });
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/9:00 PM/);
    fireEvent.keyDown(wheel('minute'), { key: 'a' });
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/9:00 AM/);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(wheel('minute'), { key: 'Enter' });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('warns when the time picked has passed, and holds back Set until it is in the future', () => {
    setup('2000-01-01T09:00');
    turnTo(10, 0);
    const warning = screen.getByTestId('reminder-preview');
    expect(warning).toHaveTextContent(/10:00 AM has already passed$/);
    expect(warning).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('reminder-confirm')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    fireEvent.click(screen.getByTestId('reminder-quick-tomorrow'));
    expect(screen.getByTestId('reminder-preview')).not.toHaveAttribute('role');
    expect(screen.getByTestId('reminder-confirm')).toBeEnabled();
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

    it('picks the time on the wheels, with no field to type into', async () => {
      mockIsMobile = true;
      const { onConfirm } = setup('2999-01-01T09:00');
      expect(screen.queryByRole('textbox')).toBeNull();
      turnTo(7, 45);
      fireEvent.click(mobileAction());
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
      const when = onConfirm.mock.calls[0][0] as Date;
      expect([when.getHours(), when.getMinutes()]).toEqual([7, 45]);
    });

    it('holds back the header action for a time that has passed', () => {
      mockIsMobile = true;
      setup('2000-01-01T09:00');
      turnTo(10, 0);
      expect(mobileAction()).toBeDisabled();
    });

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
