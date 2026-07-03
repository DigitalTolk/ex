import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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
});
