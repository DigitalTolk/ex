import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewBelowPill, UnreadBanner, UnreadDivider } from './UnreadMarkers';

describe('UnreadMarkers', () => {
  it('the line is a labelled separator the list can find', () => {
    render(<UnreadDivider />);
    const line = screen.getByRole('separator', { name: 'New messages' });
    expect(line).toHaveAttribute('data-unread-divider');
  });

  it('the banner jumps back or marks it all read, with a count that reads right', () => {
    const onJump = vi.fn();
    const onMarkRead = vi.fn();
    const { rerender } = render(<UnreadBanner count={1} onJump={onJump} onMarkRead={onMarkRead} />);
    expect(screen.getByTestId('unread-banner')).toHaveTextContent('1 new message');
    rerender(<UnreadBanner count={56} onJump={onJump} onMarkRead={onMarkRead} />);
    expect(screen.getByTestId('unread-banner')).toHaveTextContent('56 new messages');
    fireEvent.click(screen.getByTestId('unread-banner-jump'));
    fireEvent.click(screen.getByTestId('unread-banner-mark-read'));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it('the pill points down to what arrived below', () => {
    const onClick = vi.fn();
    render(<NewBelowPill count={2} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '2 new messages' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
