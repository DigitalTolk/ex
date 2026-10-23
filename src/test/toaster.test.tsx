import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { Toaster } from '@/components/Toaster';
import { showToast, TOAST_TTL_MS } from '@/lib/toast';

// sonner draws a new or updated toast on its next tick, and a closed or
// expired one leaves after a couple of frames and a 200ms exit animation.
const EXIT_MS = 300;
function toast(...args: Parameters<typeof showToast>) {
  act(() => {
    showToast(...args);
    vi.advanceTimersByTime(0);
  });
}
function wait(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}
// The frames first, so the exit's timer is set before it is waited out.
function exit() {
  wait(50);
  wait(EXIT_MS - 50);
}
const stackOf = (el: HTMLElement) => el.closest<HTMLElement>('[data-sonner-toaster]')!;

describe('Toaster', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders a success toast on showToast and auto-dismisses', () => {
    render(<Toaster />);
    // Empty → renders nothing.
    expect(screen.queryByTestId('toast')).toBeNull();

    toast('Reminder set', 'success');
    const el = screen.getByTestId('toast');
    expect(el).toHaveTextContent('Reminder set');
    expect(el).toHaveAttribute('data-variant', 'success');

    wait(TOAST_TTL_MS - 1);
    expect(screen.getByTestId('toast')).toBeInTheDocument();
    wait(1);
    exit();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('defaults to the error variant', () => {
    render(<Toaster />);
    toast('Couldn’t set the reminder');
    expect(screen.getByTestId('toast')).toHaveAttribute('data-variant', 'error');
  });

  it('shows nothing after unmount', () => {
    const { unmount } = render(<Toaster />);
    unmount();
    toast('ignored');
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('renders a bold title line when provided', () => {
    render(<Toaster />);
    toast('New message body', 'success', { title: 'Alice in ~general' });
    const el = screen.getByTestId('toast');
    expect(el).toHaveTextContent('Alice in ~general');
    expect(el).toHaveTextContent('New message body');
    // Plain informational toast stays a non-interactive div.
    expect(el.tagName).toBe('DIV');
  });

  it('an actionable toast is a button: tap runs the action and dismisses immediately', () => {
    const onActivate = vi.fn();
    render(<Toaster />);
    toast('Tap to open', 'success', { title: 'Alice', onActivate });
    const el = screen.getByTestId('toast');
    expect(el.tagName).toBe('BUTTON');
    act(() => {
      el.click();
    });
    expect(onActivate).toHaveBeenCalledTimes(1);
    // Dismissed on tap — gone after the exit animation, no waiting for the
    // auto-dismiss timer.
    exit();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('a notification-kind toast renders as an inverted TOP banner', () => {
    render(<Toaster />);
    toast('New message body', 'success', {
      title: 'Alice in ~general',
      kind: 'notification',
      onActivate: () => undefined,
    });
    const el = screen.getByTestId('toast');
    expect(el).toHaveAttribute('data-kind', 'notification');
    // Distinct notification palette (faint yellow / near-black per theme) —
    // must never blend into the app, and is NOT the plain card surface.
    expect(el.className).toContain('bg-notification-toast');
    expect(el.className).toContain('text-notification-toast-foreground');
    expect(el.className).not.toContain('bg-card');
    // Always a fixed WIDE box, not sized to the message content.
    expect(el.className).toContain('w-full');
    expect(el.className).toContain('max-w-md');
    expect(el.className).not.toContain('max-w-sm');
    // In the top stack, clear of the notch / status bar.
    const stack = stackOf(el);
    expect(stack).toHaveAttribute('data-y-position', 'top');
    expect(stack.style.getPropertyValue('--offset-top')).toContain('env(safe-area-inset-top)');
    expect(stack.style.getPropertyValue('--mobile-offset-top')).toContain('env(safe-area-inset-top)');
    // Announced politely.
    expect(stack.closest('section')).toHaveAttribute('aria-live', 'polite');
  });

  it('notification banners and plain toasts render in separate stacks', () => {
    render(<Toaster />);
    toast('banner', 'success', { kind: 'notification', onActivate: () => undefined });
    toast('plain error');
    const all = screen.getAllByTestId('toast');
    expect(all).toHaveLength(2);
    const banner = all.find((t) => t.getAttribute('data-kind') === 'notification')!;
    const plain = all.find((t) => t.getAttribute('data-kind') !== 'notification')!;
    expect(stackOf(banner)).toHaveAttribute('data-y-position', 'top');
    expect(stackOf(plain)).toHaveAttribute('data-y-position', 'bottom');
    expect(stackOf(plain).style.getPropertyValue('--offset-bottom')).toContain('env(safe-area-inset-bottom)');
    expect(stackOf(banner)).not.toBe(stackOf(plain));
    expect(plain.className).toContain('bg-card');
  });

  describe('notification banners', () => {
    const banner = (message: string, group: string, onActivate = vi.fn()) =>
      toast(message, 'success', { title: 'Alice in ~general', kind: 'notification', group, onActivate });
    const bannerWith = (text: string) => screen.getAllByTestId('toast').find((t) => t.textContent?.includes(text))!;

    it('shows one banner per conversation: the newest message and how many arrived', () => {
      render(<Toaster />);
      banner('first', 'ch-1:');
      banner('second', 'ch-1:');
      banner('third', 'ch-1:');
      banner('elsewhere', 'ch-2:');
      // Newest banner first, at the top edge.
      const all = screen.getAllByTestId('toast');
      expect(all).toHaveLength(2);
      expect(all[1]).toHaveTextContent('third');
      expect(all[1]).not.toHaveTextContent('first');
      expect(all[1]).toHaveTextContent('3 messages');
      expect(all[0]).toHaveTextContent('elsewhere');
      expect(all[0].querySelector('[data-testid="toast-count"]')).toBeNull();
    });

    it('keeps a busy conversation\'s banner up while messages keep arriving', () => {
      render(<Toaster />);
      banner('first', 'ch-1:');
      wait(3000);
      banner('second', 'ch-1:');
      wait(3000);
      expect(screen.getByTestId('toast')).toHaveTextContent('second');
      wait(1000);
      exit();
      expect(screen.queryByTestId('toast')).toBeNull();
      // Gone, it starts over: the next message is a banner of its own.
      banner('later', 'ch-1:');
      expect(screen.getByTestId('toast')).toHaveTextContent('later');
      expect(screen.queryByTestId('toast-count')).toBeNull();
    });

    it('opens the newest message when tapped', () => {
      const first = vi.fn();
      const newest = vi.fn();
      render(<Toaster />);
      banner('first', 'ch-1:', first);
      banner('second', 'ch-1:', newest);
      act(() => screen.getByTestId('toast-open').click());
      expect(newest).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
      exit();
      expect(screen.queryByTestId('toast')).toBeNull();
    });

    it('closes without opening anything', () => {
      const onActivate = vi.fn();
      render(<Toaster />);
      banner('first', 'ch-1:', onActivate);
      banner('other', 'ch-2:');
      act(() => within(bannerWith('first')).getByRole('button', { name: 'Dismiss' }).click());
      expect(onActivate).not.toHaveBeenCalled();
      exit();
      expect(screen.getAllByTestId('toast')).toHaveLength(1);
      expect(screen.getByTestId('toast')).toHaveTextContent('other');
      // Its timer went with it: nothing else is put away early.
      wait(TOAST_TTL_MS - 1 - EXIT_MS);
      expect(screen.getByTestId('toast')).toHaveTextContent('other');
    });

    it('closes a banner that has nothing to open', () => {
      render(<Toaster />);
      toast('approve the deploy', 'success', { title: 'Agent', kind: 'notification' });
      expect(screen.queryByTestId('toast-open')).toBeNull();
      expect(screen.getByTestId('toast')).toHaveTextContent('approve the deploy');
      act(() => screen.getByRole('button', { name: 'Dismiss' }).click());
      exit();
      expect(screen.queryByTestId('toast')).toBeNull();
    });

    it('a closed conversation\'s next message is a banner of its own, even mid-exit', () => {
      render(<Toaster />);
      banner('first', 'ch-1:');
      banner('second', 'ch-1:');
      act(() => screen.getByRole('button', { name: 'Dismiss' }).click());
      banner('third', 'ch-1:');
      exit();
      expect(screen.getByTestId('toast')).toHaveTextContent('third');
      expect(screen.queryByTestId('toast-count')).toBeNull();
    });

    it('updates a conversation\'s banner in place among others', () => {
      render(<Toaster />);
      banner('first', 'ch-1:');
      banner('other', 'ch-2:');
      banner('second', 'ch-1:');
      // The ch-1 banner keeps its slot behind the newer ch-2 one instead of
      // being drawn again as the newest.
      const all = screen.getAllByTestId('toast');
      expect(all.map((t) => t.textContent)).toEqual([
        expect.stringContaining('other'),
        expect.stringContaining('second'),
      ]);
    });

    // A banner under a finger stays until the finger lifts, then has its
    // full time again; a message arriving meanwhile doesn't put it away.
    it('waits while it is held', () => {
      render(<Toaster />);
      banner('first', 'ch-1:');
      wait(2000);
      fireEvent.pointerDown(screen.getByTestId('toast'));
      wait(5000);
      banner('second', 'ch-1:');
      wait(5000);
      expect(screen.getByTestId('toast')).toHaveTextContent('second');
      act(() => {
        fireEvent.pointerUp(window);
      });
      wait(TOAST_TTL_MS - 1);
      expect(screen.getByTestId('toast')).toBeInTheDocument();
      wait(1);
      exit();
      expect(screen.queryByTestId('toast')).toBeNull();
    });

    it('holding one banner leaves the others on their own time', () => {
      render(<Toaster />);
      banner('held', 'ch-1:');
      banner('other', 'ch-2:');
      fireEvent.pointerDown(bannerWith('held'));
      wait(TOAST_TTL_MS);
      exit();
      expect(screen.getAllByTestId('toast').map((t) => t.textContent)).toEqual([expect.stringContaining('held')]);
      act(() => {
        fireEvent.pointerUp(window);
      });
    });

    it('a banner closed while held stays closed when the finger lifts', () => {
      render(<Toaster />);
      banner('first', 'ch-1:');
      fireEvent.pointerDown(screen.getByTestId('toast'));
      act(() => screen.getByRole('button', { name: 'Dismiss' }).click());
      act(() => {
        fireEvent.pointerUp(window);
      });
      exit();
      expect(screen.queryByTestId('toast')).toBeNull();
    });

    it('keeps ungrouped banners apart', () => {
      render(<Toaster />);
      toast('one', 'success', { kind: 'notification' });
      toast('two', 'success', { kind: 'notification' });
      expect(screen.getAllByTestId('toast')).toHaveLength(2);
    });

    it('a new Toaster starts with no groups', () => {
      const first = render(<Toaster />);
      banner('first', 'ch-1:');
      first.unmount();
      render(<Toaster />);
      banner('again', 'ch-1:');
      expect(screen.getByTestId('toast')).toHaveTextContent('again');
      expect(screen.queryByTestId('toast-count')).toBeNull();
    });
  });
});
