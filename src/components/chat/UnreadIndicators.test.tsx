import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewMessagesPill, UnreadBanner, UnreadDividerRow } from './UnreadIndicators';

describe('UnreadIndicators (jsdom)', () => {
  it('the divider reports itself visible when IntersectionObserver is unavailable', () => {
    // jsdom has no IntersectionObserver: the banner must not get stuck.
    expect(typeof IntersectionObserver).toBe('undefined');
    const onPosition = vi.fn();
    render(<UnreadDividerRow root={null} onPosition={onPosition} />);
    expect(onPosition).toHaveBeenCalledWith('visible');
    expect(screen.getByRole('separator', { name: 'New messages' })).toBeTruthy();
  });

  it('Esc dismisses the banner (deferred until the event finishes dispatching)', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<UnreadBanner count={1} onJump={vi.fn()} onDismiss={onDismiss} />);
    expect(screen.getByTestId('unread-banner').textContent).toContain('1 new message');
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // Dismissing READS the channel, so Esc meant for anything else must not.
  it('ignores Esc that belongs to something else', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<UnreadBanner count={1} onJump={vi.fn()} onDismiss={onDismiss} />);

    // Already claimed before reaching the banner.
    const claimed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    claimed.preventDefault();
    window.dispatchEvent(claimed);

    // Typed in an editable (composer, search, inline edit).
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    input.remove();

    // An overlay (dialog, lightbox, menu, popover) is open.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: 'Escape' });
    dialog.remove();

    // Claimed by a handler that runs AFTER the banner's own listener.
    const late = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener('keydown', late);
    fireEvent.keyDown(window, { key: 'Escape' });
    window.removeEventListener('keydown', late);

    vi.runAllTimers();
    expect(onDismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('the pill pluralises and fires its click', () => {
    const onClick = vi.fn();
    render(<NewMessagesPill count={3} onClick={onClick} />);
    fireEvent.click(screen.getByTestId('new-messages-pill'));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByTestId('new-messages-pill').textContent).toContain('3 new messages');
  });
});
