import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ScheduleSendMenu } from './ScheduleSendMenu';
import { SCHEDULE_PRESETS } from '@/lib/schedule-times';

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
    // The picker's module loads on its first open.
    expect(await screen.findByRole('heading', { name: 'Schedule message' })).toBeInTheDocument();
    // Every quick pick fills the fields with a future instant.
    for (const key of ['in1h', 'in3h', 'nextweek', 'tomorrow']) {
      fireEvent.click(screen.getByTestId(`reminder-quick-${key}`));
      expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/^Sends /);
    }
    // Tomorrow morning is now set; type a different time for it.
    fireEvent.change(screen.getByTestId('reminder-time'), { target: { value: '8:30' } });
    expect(screen.getByTestId('reminder-preview')).toHaveTextContent(/^Sends Tomorrow at 8:30/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    });
    const when = onSchedule.mock.calls[0][0] as Date;
    expect([when.getHours(), when.getMinutes()]).toEqual([8, 30]);
    expect(when.getTime()).toBeGreaterThan(Date.now());
    // Closing the picker forgets it.
    fireEvent.click(screen.getByLabelText('Pick a custom time'));
    fireEvent.click(screen.getByTestId('reminder-cancel'));
    expect(screen.queryByRole('heading', { name: 'Schedule message' })).toBeNull();
  });
});

// Phone: Send itself is the trigger — a tap sends, a press and hold opens the
// schedule options in a popover that never takes focus (so the keyboard stays).
describe('ScheduleSendMenu (hold mode)', () => {
  const HOLD_WAIT = 600;
  const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

  function renderHold(onSchedule = vi.fn().mockResolvedValue(undefined)) {
    const onSend = vi.fn();
    const onOpenChange = vi.fn();
    const editor = document.createElement('textarea');
    document.body.appendChild(editor);
    editor.focus();
    const view = render(
      <ScheduleSendMenu
        disabled={false}
        onSchedule={onSchedule}
        onOpenChange={onOpenChange}
        hold={{ onSend, label: 'Send message', children: <span>send</span> }}
      />,
    );
    const button = screen.getByTestId('schedule-send-hold');
    return { ...view, onSend, onSchedule, onOpenChange, editor, button };
  }

  async function hold(button: HTMLElement) {
    fireEvent.pointerDown(button);
    await wait(HOLD_WAIT);
  }

  it('a tap sends, and never opens the options', async () => {
    const { button, onSend, editor } = renderHold();
    expect(button).toHaveAccessibleName('Send message');
    expect(button).toHaveAttribute('data-keeps-keyboard');
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(onSend).toHaveBeenCalledTimes(1);
    await wait(HOLD_WAIT);
    expect(screen.queryByTestId('schedule-send-hold-menu')).toBeNull();
    editor.remove();
  });

  it('a hold opens the options without taking focus, and the release does not also send', async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    const { button, onSend, onOpenChange, editor } = renderHold();
    await hold(button);
    const menu = await screen.findByTestId('schedule-send-hold-menu');
    expect(menu).toHaveAttribute('data-keeps-keyboard');
    expect(vibrate).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(document.activeElement).toBe(editor);
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('schedule-send-hold-menu')).toBeInTheDocument();
    // Pressing inside the popover keeps focus where it was.
    expect(fireEvent.pointerDown(menu)).toBe(false);
    expect(fireEvent.mouseDown(menu)).toBe(false);
    // A later tap sends again.
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(onSend).toHaveBeenCalledTimes(1);
    editor.remove();
  });

  it('a lifted, cancelled or wandering finger never opens it, and no callout appears', async () => {
    const { button, editor } = renderHold();
    for (const end of [fireEvent.pointerUp, fireEvent.pointerLeave, fireEvent.pointerCancel]) {
      fireEvent.pointerDown(button);
      end(button);
    }
    await wait(HOLD_WAIT);
    expect(screen.queryByTestId('schedule-send-hold-menu')).toBeNull();
    expect(fireEvent.contextMenu(button)).toBe(false);
    editor.remove();
  });

  it('picking a preset schedules it, closes the options and drops the keyboard', async () => {
    const { button, onSchedule, editor } = renderHold();
    await hold(button);
    fireEvent.click(await screen.findByLabelText(/^Send Tomorrow at/));
    expect(onSchedule).toHaveBeenCalledTimes(1);
    expect((onSchedule.mock.calls[0][0] as Date).getTime()).toBeGreaterThan(Date.now());
    expect(document.activeElement).not.toBe(editor);
    await vi.waitFor(() => expect(screen.queryByTestId('schedule-send-hold-menu')).toBeNull());
    editor.remove();
  });

  // A finger that starts on Send and slides off into a scroll is not a hold.
  it('a press that moves before the hold completes never opens the options', async () => {
    const { button, onOpenChange, editor } = renderHold();
    fireEvent.pointerDown(button, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(button, { clientX: 10, clientY: 40 });
    await wait(HOLD_WAIT);
    expect(screen.queryByTestId('schedule-send-hold-menu')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    editor.remove();
  });

  it('a press cut short by the composer going away opens nothing later', async () => {
    const { button, onOpenChange, editor, unmount } = renderHold();
    fireEvent.pointerDown(button);
    unmount();
    await wait(HOLD_WAIT);
    expect(onOpenChange).not.toHaveBeenCalled();
    editor.remove();
  });

  it('a failed schedule is swallowed (the composer keeps its text)', async () => {
    const { button, onSchedule, editor } = renderHold(vi.fn().mockRejectedValue(new Error('nope')));
    await hold(button);
    // The label is the app's own, in the runtime's locale ("Monday", "Mon",
    // "måndag" …), never a hard-coded English one.
    const nextWeek = SCHEDULE_PRESETS.find((p) => p.key === 'nextweek')!.label;
    fireEvent.click(await screen.findByLabelText(`Send ${nextWeek}`));
    await act(async () => {});
    expect(onSchedule).toHaveBeenCalledTimes(1);
    editor.remove();
  });

  it('Custom time opens the picker; Escape closes the options', async () => {
    const { button, editor, onOpenChange } = renderHold();
    await hold(button);
    fireEvent.click(await screen.findByLabelText('Pick a custom time'));
    expect(await screen.findByRole('heading', { name: 'Schedule message' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('reminder-cancel'));
    await hold(button);
    await screen.findByTestId('schedule-send-hold-menu');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByTestId('schedule-send-hold-menu')).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    editor.remove();
  });
});
