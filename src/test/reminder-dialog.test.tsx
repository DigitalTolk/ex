import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const hourInput = () => screen.getByTestId('reminder-dial-hour-input') as HTMLInputElement;
const minuteInput = () => screen.getByTestId('reminder-dial-minute-input') as HTMLInputElement;

// Types a time into the hour and the minutes above the dial.
function typeTime(hour: string, minute: string) {
  fireEvent.focus(hourInput());
  fireEvent.change(hourInput(), { target: { value: hour } });
  fireEvent.focus(minuteInput());
  fireEvent.change(minuteInput(), { target: { value: minute } });
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

  // Scheduled sends use the same dialog, with no note.
  it('has a note field only when asked for one, and passes it on trimmed', async () => {
    setup('2999-01-01T09:00');
    expect(screen.queryByTestId('reminder-note')).toBeNull();
    cleanup();

    const onConfirm = vi.fn((_when: Date, _people: string[], _note: string) => Promise.resolve());
    render(<ReminderDialog open initialValue="2999-01-01T09:00" onConfirm={onConfirm} onOpenChange={vi.fn()} note="" />);
    const note = screen.getByRole('textbox', { name: 'Reminder note' });
    expect(note).toHaveValue('');
    expect(note).toHaveAttribute('maxLength', '500');
    fireEvent.change(note, { target: { value: '  bring the Q3 numbers\n' } });
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.any(Date), [], 'bring the Q3 numbers'));
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
    expect(hourInput()).toHaveValue('');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toHaveTextContent('Pick a time.');
    typeTime('9', '30');
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    expect(screen.getByTestId('reminder-error')).toHaveTextContent('Pick a date');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('picks a day on the calendar and a typed time, previews the result, then confirms it', async () => {
    const { onConfirm } = setup('2999-01-01T09:00');
    expect(screen.queryByTestId('reminder-preview')).toBeNull();
    // The calendar opens on the seed's month.
    fireEvent.click(screen.getByTestId('reminder-day-2999-01-15'));
    // The time is typed where it's shown, above the dial.
    typeTime('10', '30');
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/^Reminds you .*10:30/);
    fireEvent.click(screen.getByTestId('reminder-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const when = onConfirm.mock.calls[0][0] as Date;
    expect([when.getMonth(), when.getDate(), when.getHours(), when.getMinutes()]).toEqual([0, 15, 10, 30]);
  });

  it('the dial and the time above it set each other, and arrow keys step it', () => {
    setup('2999-01-01T09:00');
    // The dial opens on the hours, with the seed's hour chosen.
    expect(screen.getByTestId('reminder-dial-hour-9')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('reminder-dial-pm'));
    fireEvent.click(screen.getByTestId('reminder-dial-hour-14'));
    // Picking the hour turns the dial to the minutes.
    fireEvent.click(screen.getByTestId('reminder-dial-minute-15'));
    expect(hourInput()).toHaveValue('2');
    expect(minuteInput()).toHaveValue('15');
    expect(screen.getByTestId('reminder-dial-minute-15')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/2:15 PM/);
    fireEvent.keyDown(minuteInput(), { key: 'ArrowDown' });
    expect(minuteInput()).toHaveValue('14');
    fireEvent.keyDown(hourInput(), { key: 'ArrowUp' });
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/3:14 PM/);
    // Other keys pass through.
    fireEvent.keyDown(hourInput(), { key: 'x' });
    expect(hourInput()).toHaveValue('3');
  });

  it('takes digits only, and leaves a time that is out of range as it was', () => {
    setup('2999-01-01T09:00');
    fireEvent.focus(hourInput());
    fireEvent.change(hourInput(), { target: { value: '1x3' } });
    // "13" is no 12-hour hour: shown while typed, not applied, gone on leaving.
    expect(hourInput()).toHaveValue('13');
    expect(screen.queryByTestId('reminder-preview')).toBeNull();
    fireEvent.blur(hourInput());
    expect(hourInput()).toHaveValue('9');
    fireEvent.focus(minuteInput());
    fireEvent.change(minuteInput(), { target: { value: '75' } });
    fireEvent.blur(minuteInput());
    expect(minuteInput()).toHaveValue('00');
    // Cleared, it waits for digits.
    fireEvent.change(minuteInput(), { target: { value: '' } });
    expect(minuteInput()).toHaveValue('');
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
    expect(hourInput()).toHaveValue('9');
    expect(minuteInput()).toHaveValue('00');
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/^Reminds you Tomorrow at .*9:00 AM/);
    fireEvent.keyDown(hourInput(), { key: 'p' });
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/9:00 PM/);
    fireEvent.keyDown(minuteInput(), { key: 'a' });
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/9:00 AM/);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(minuteInput(), { key: 'Enter' });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('shows no preview for a time already in the past', () => {
    setup('2000-01-01T09:00');
    typeTime('10', '00');
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

    it('picks the time on the dial alone, with no field to type into', async () => {
      mockIsMobile = true;
      const { onConfirm } = setup('2999-01-01T09:00');
      fireEvent.click(screen.getByTestId('reminder-dial-hour-7'));
      fireEvent.click(screen.getByTestId('reminder-dial-minute-45'));
      fireEvent.click(mobileAction());
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
      const when = onConfirm.mock.calls[0][0] as Date;
      expect([when.getHours(), when.getMinutes()]).toEqual([7, 45]);
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
