import { render, screen, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserAvatar } from './UserAvatar';

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

describe('UserAvatar', () => {
  it('renders presence without overlaying status on top of the avatar', () => {
    render(<UserAvatar displayName="Ada Lovelace" online />);

    expect(screen.getByLabelText('Online')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Working from home/)).toBeNull();
  });

  it('falls back to "??" initials when displayName is empty', () => {
    const { container } = render(<UserAvatar displayName="" />);
    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    // getInitials('??') collapses the placeholder to a single '?'.
    expect(fallback?.textContent).toBe('?');
  });

  it('renders the image, then swaps to initials on load error', () => {
    const { container } = render(<UserAvatar displayName="Ada Lovelace" avatarURL="https://x/a.png" />);
    const img = container.querySelector('img[data-slot="avatar-image"]') as HTMLImageElement;
    expect(img).toBeTruthy();
    // Simulate a broken image → fallback initials render instead.
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe('AL');
  });

  it('renders the offline dot when online is false', () => {
    render(<UserAvatar displayName="Ada" online={false} />);
    expect(screen.getByLabelText('Offline')).toBeInTheDocument();
  });

  it('omits the presence dot entirely when online is undefined', () => {
    render(<UserAvatar displayName="Ada" />);
    expect(screen.queryByLabelText('Online')).toBeNull();
    expect(screen.queryByLabelText('Offline')).toBeNull();
  });
});
