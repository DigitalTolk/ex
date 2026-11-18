import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelRow } from './ChannelRow';
import type { UserChannel } from '@/types';

// Force the mobile branch so the long-press → controlled-menu path is exercised.
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true }));

const channel: UserChannel = {
  channelID: 'ch-1',
  channelName: 'general',
  channelType: 'public',
  role: 1,
};

function renderRow(props: Partial<React.ComponentProps<typeof ChannelRow>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/channel/start']}>
        <ChannelRow onNavigate={vi.fn()} channel={channel} hasUnread={false} onClose={vi.fn()} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChannelRow', () => {
  it('suppresses navigation and notifies the consumer when suppressNavigation is set', () => {
    const onSuppressNavigationConsumed = vi.fn();
    const onClose = vi.fn();
    renderRow({ suppressNavigation: true, onSuppressNavigationConsumed, onClose });

    const link = screen.getByText('general').closest('a')!;
    fireEvent.click(link);

    // The suppressed click prevents default navigation and calls the consumer
    // instead of onClose.
    expect(onSuppressNavigationConsumed).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("draws the channel's own emoji in place of the globe, with a small lock kept for a private one", () => {
    const { unmount } = renderRow({ channel: { ...channel, icon: 'tada' } });
    const row = screen.getByTestId('channel-row-ch-1');
    expect(row.querySelector('[data-testid="channel-emoji"]')).not.toBeNull();
    expect(row.querySelector('svg.lucide-globe')).toBeNull();
    // A public channel needs no mark.
    expect(screen.queryByTestId('channel-private-mark')).toBeNull();
    unmount();

    renderRow({ channel: { ...channel, channelType: 'private', icon: 'tada' } });
    expect(screen.getByTestId('channel-private-mark')).toHaveAccessibleName('Private');
  });

  it('keeps the globe or the lock for a channel with no emoji', () => {
    const { unmount } = renderRow();
    expect(screen.getByTestId('channel-row-ch-1').querySelector('svg.lucide-globe')).not.toBeNull();
    expect(screen.queryByTestId('channel-emoji')).toBeNull();
    unmount();

    renderRow({ channel: { ...channel, channelType: 'private' } });
    expect(screen.getByTestId('channel-row-ch-1').querySelector('svg.lucide-lock')).not.toBeNull();
    // The lock is the icon itself: no second mark after the name.
    expect(screen.queryByTestId('channel-private-mark')).toBeNull();
  });

  it('navigates normally (calling onClose) when navigation is not suppressed', () => {
    const onClose = vi.fn();
    renderRow({ onClose });

    fireEvent.click(screen.getByText('general').closest('a')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the menu on a mobile long-press and swallows the follow-up nav click', () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      renderRow({ onClose });
      const row = screen.getByTestId('channel-row-ch-1');
      fireEvent.pointerDown(row, { pointerType: 'touch' });
      // Hold past the long-press delay → onLongPress opens the menu.
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByText('Move to Channels')).toBeInTheDocument();
      // The click a touch release fires right after must not navigate.
      fireEvent.pointerUp(row, { pointerType: 'touch' });
      fireEvent.click(screen.getByText('general').closest('a')!);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
