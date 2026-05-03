import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserStatusIndicator } from './UserStatusIndicator';

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: (enabled = true) => ({
    data: enabled ? {} : undefined,
  }),
}));

describe('UserStatusIndicator', () => {
  it('renders active status emoji with accessible hover text', () => {
    render(<UserStatusIndicator status={{ emoji: ':house:', text: 'Working from home' }} />);

    expect(screen.getByLabelText(/Working from home/)).toBeInTheDocument();
  });

  it('renders persisted status until the backend sweeper clears it', () => {
    render(
      <UserStatusIndicator
        status={{ emoji: ':sandwich:', text: 'Out for Lunch', clearAt: '2020-01-01T10:00:00.000Z' }}
      />,
    );

    expect(screen.getByLabelText(/Out for Lunch/)).toBeInTheDocument();
  });

  it('renders active status with a future clear time', () => {
    render(
      <UserStatusIndicator
        className="status-inline"
        status={{ emoji: ':spiral_calendar:', text: 'In a meeting', clearAt: '2030-01-01T10:00:00.000Z' }}
      />,
    );

    expect(screen.getByLabelText(/In a meeting, until/)).toHaveClass('status-inline');
  });

  it('can render without its own hover tooltip inside larger hover cards', () => {
    render(<UserStatusIndicator tooltip={false} status={{ emoji: ':house:', text: 'Working from home' }} />);

    expect(screen.getByLabelText(/Working from home/).tagName).toBe('SPAN');
  });

  it('does not render incomplete statuses', () => {
    const { container } = render(<UserStatusIndicator status={{ emoji: '', text: 'No emoji' }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
