import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { Toaster } from '@/components/Toaster';
import { showToast } from '@/lib/toast';

describe('Toaster', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders a success toast on showToast and auto-dismisses', () => {
    render(<Toaster />);
    // Empty → renders nothing.
    expect(screen.queryByTestId('toast')).toBeNull();

    act(() => showToast('Reminder set', 'success'));
    const toast = screen.getByTestId('toast');
    expect(toast).toHaveTextContent('Reminder set');
    expect(toast).toHaveAttribute('data-variant', 'success');

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('defaults to the error variant', () => {
    render(<Toaster />);
    act(() => showToast('Couldn’t set the reminder'));
    expect(screen.getByTestId('toast')).toHaveAttribute('data-variant', 'error');
  });

  it('stops listening after unmount', () => {
    const { unmount } = render(<Toaster />);
    unmount();
    // No listener → dispatch is a no-op, and no error/leak.
    act(() => showToast('ignored'));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('renders a bold title line when provided', () => {
    render(<Toaster />);
    act(() => showToast('New message body', 'success', { title: 'Alice in ~general' }));
    const toast = screen.getByTestId('toast');
    expect(toast).toHaveTextContent('Alice in ~general');
    expect(toast).toHaveTextContent('New message body');
    // Plain informational toast stays a non-interactive div.
    expect(toast.tagName).toBe('DIV');
  });

  it('an actionable toast is a button: tap runs the action and dismisses immediately', () => {
    const onActivate = vi.fn();
    render(<Toaster />);
    act(() => showToast('Tap to open', 'success', { title: 'Alice', onActivate }));
    const toast = screen.getByTestId('toast');
    expect(toast.tagName).toBe('BUTTON');
    act(() => {
      toast.click();
    });
    expect(onActivate).toHaveBeenCalledTimes(1);
    // Dismissed on tap — no waiting for the auto-dismiss timer.
    expect(screen.queryByTestId('toast')).toBeNull();
  });
  it('a notification-kind toast renders as an inverted TOP banner', () => {
    render(<Toaster />);
    act(() =>
      showToast('New message body', 'success', {
        title: 'Alice in ~general',
        kind: 'notification',
        onActivate: () => undefined,
      }),
    );
    const toast = screen.getByTestId('toast');
    expect(toast).toHaveAttribute('data-kind', 'notification');
    // Distinct notification palette (faint yellow / near-black per theme) —
    // must never blend into the app, and is NOT the plain card surface.
    expect(toast.className).toContain('bg-notification-toast');
    expect(toast.className).toContain('text-notification-toast-foreground');
    expect(toast.className).not.toContain('bg-card');
    // Always a fixed WIDE box, not sized to the message content.
    expect(toast.className).toContain('w-full');
    expect(toast.className).toContain('max-w-md');
    expect(toast.className).not.toContain('max-w-sm');
    // Positioned in the top banner container, not the bottom toast stack.
    expect((toast.parentElement as HTMLElement).className).toContain('top-[calc(env(safe-area-inset-top)');
  });

  it('notification banners and plain toasts render in separate stacks', () => {
    render(<Toaster />);
    act(() => {
      showToast('banner', 'success', { kind: 'notification', onActivate: () => undefined });
      showToast('plain error');
    });
    const all = screen.getAllByTestId('toast');
    expect(all).toHaveLength(2);
    const banner = all.find((t) => t.getAttribute('data-kind') === 'notification')!;
    const plain = all.find((t) => t.getAttribute('data-kind') !== 'notification')!;
    expect((banner.parentElement as HTMLElement).className).toContain('top-');
    expect((plain.parentElement as HTMLElement).className).toContain('bottom-');
    expect(plain.className).toContain('bg-card');
  });

  describe('notification banners', () => {
    const banner = (message: string, group: string, onActivate = vi.fn()) =>
      showToast(message, 'success', { title: 'Alice in ~general', kind: 'notification', group, onActivate });

    it('shows one banner per conversation: the newest message and how many arrived', () => {
      render(<Toaster />);
      act(() => {
        banner('first', 'ch-1:');
        banner('second', 'ch-1:');
        banner('third', 'ch-1:');
        banner('elsewhere', 'ch-2:');
      });
      const all = screen.getAllByTestId('toast');
      expect(all).toHaveLength(2);
      expect(all[0]).toHaveTextContent('third');
      expect(all[0]).not.toHaveTextContent('first');
      expect(all[0]).toHaveTextContent('3 messages');
      expect(all[1]).toHaveTextContent('elsewhere');
      expect(all[1].querySelector('[data-testid="toast-count"]')).toBeNull();
    });

    it('keeps a busy conversation\'s banner up while messages keep arriving', () => {
      render(<Toaster />);
      act(() => banner('first', 'ch-1:'));
      act(() => vi.advanceTimersByTime(3000));
      act(() => banner('second', 'ch-1:'));
      act(() => vi.advanceTimersByTime(3000));
      expect(screen.getByTestId('toast')).toHaveTextContent('second');
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByTestId('toast')).toBeNull();
      // Gone, it starts over: the next message is a banner of its own.
      act(() => banner('later', 'ch-1:'));
      expect(screen.getByTestId('toast')).toHaveTextContent('later');
      expect(screen.queryByTestId('toast-count')).toBeNull();
    });

    it('opens the newest message when tapped', () => {
      const first = vi.fn();
      const newest = vi.fn();
      render(<Toaster />);
      act(() => {
        banner('first', 'ch-1:', first);
        banner('second', 'ch-1:', newest);
      });
      act(() => screen.getByTestId('toast-open').click());
      expect(newest).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
      expect(screen.queryByTestId('toast')).toBeNull();
    });

    it('closes without opening anything', () => {
      const onActivate = vi.fn();
      render(<Toaster />);
      act(() => {
        banner('first', 'ch-1:', onActivate);
        banner('other', 'ch-2:');
      });
      act(() => screen.getAllByRole('button', { name: 'Dismiss' })[0].click());
      expect(onActivate).not.toHaveBeenCalled();
      expect(screen.getAllByTestId('toast')).toHaveLength(1);
      expect(screen.getByTestId('toast')).toHaveTextContent('other');
      // Its timer went with it: nothing else is put away early.
      act(() => vi.advanceTimersByTime(3999));
      expect(screen.getByTestId('toast')).toHaveTextContent('other');
    });

    it('closes a banner that has nothing to open', () => {
      render(<Toaster />);
      act(() => showToast('approve the deploy', 'success', { title: 'Agent', kind: 'notification' }));
      expect(screen.queryByTestId('toast-open')).toBeNull();
      expect(screen.getByTestId('toast')).toHaveTextContent('approve the deploy');
      act(() => screen.getByRole('button', { name: 'Dismiss' }).click());
      expect(screen.queryByTestId('toast')).toBeNull();
    });

    it('updates a conversation\'s banner in place among others', () => {
      render(<Toaster />);
      act(() => {
        banner('other', 'ch-2:');
        banner('first', 'ch-1:');
        banner('second', 'ch-1:');
      });
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
      act(() => banner('first', 'ch-1:'));
      fireEvent.pointerDown(screen.getByTestId('toast'));
      act(() => vi.advanceTimersByTime(5000));
      act(() => banner('second', 'ch-1:'));
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByTestId('toast')).toHaveTextContent('second');
      act(() => {
        fireEvent.pointerUp(window);
      });
      act(() => vi.advanceTimersByTime(3999));
      expect(screen.getByTestId('toast')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByTestId('toast')).toBeNull();
    });

    it('keeps ungrouped banners apart', () => {
      render(<Toaster />);
      act(() => {
        showToast('one', 'success', { kind: 'notification' });
        showToast('two', 'success', { kind: 'notification' });
      });
      expect(screen.getAllByTestId('toast')).toHaveLength(2);
    });
  });
});
