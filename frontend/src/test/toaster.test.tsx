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
});
