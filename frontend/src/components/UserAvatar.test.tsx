import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserAvatar } from './UserAvatar';

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

describe('UserAvatar', () => {
  it('renders presence without overlaying status on top of the avatar', () => {
    render(
      <UserAvatar
        displayName="Ada Lovelace"
        online
        userStatus={{ emoji: ':house:', text: 'Working from home' }}
      />,
    );

    expect(screen.getByLabelText('Online')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Working from home/)).toBeNull();
  });
});
