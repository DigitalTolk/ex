import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { ChannelRow } from './ChannelRow';
import type { UserChannel } from '@/types';

const favoriteMutate = vi.hoisted(() => vi.fn());
const setCategoryMutate = vi.hoisted(() => vi.fn());
const categoriesData = vi.hoisted(() => ({ data: [] as { id: string; name: string }[] }));

vi.mock('@/hooks/useSidebar', () => ({
  useFavoriteChannel: () => ({ mutate: favoriteMutate, isPending: false }),
  useSetCategory: () => ({ mutate: setCategoryMutate, isPending: false }),
  useCategories: () => categoriesData,
}));

beforeEach(() => {
  favoriteMutate.mockReset();
  setCategoryMutate.mockReset();
  categoriesData.data = [];
});

const baseChannel: UserChannel = {
  channelID: 'ch-1',
  channelName: 'general',
  channelType: 'public',
  muted: false,
  favorite: false,
  categoryID: '',
  unreadCount: 0,
};

function renderRow(channel: UserChannel = baseChannel, hasUnread = false) {
  return render(
    <MemoryRouter>
      <ChannelRow channel={channel} hasUnread={hasUnread} onClose={() => {}} />
    </MemoryRouter>,
  );
}

describe('ChannelRow browser behaviour', () => {
  it('renders the channel name with a public-channel icon', async () => {
    const screen = await renderRow();
    await expect.element(screen.getByText('general')).toBeVisible();
  });

  it('shows the muted bell-slash icon when channel.muted is true', async () => {
    await renderRow({ ...baseChannel, muted: true });
    expect(document.querySelector('[aria-label="Muted"]')).not.toBeNull();
  });

  it('toggles favorite via useFavoriteChannel and clears category when favoriting', async () => {
    await renderRow();
    const star = document.querySelector('[data-testid="fav-toggle-ch-1"]') as HTMLButtonElement;
    star.click();
    expect(setCategoryMutate).toHaveBeenCalledWith({ channelID: 'ch-1', categoryID: '' });
    expect(favoriteMutate).toHaveBeenCalledWith({ channelID: 'ch-1', favorite: true });
  });

  it('unfavoriting does not touch the category', async () => {
    await renderRow({ ...baseChannel, favorite: true });
    const star = document.querySelector('[data-testid="fav-toggle-ch-1"]') as HTMLButtonElement;
    star.click();
    expect(setCategoryMutate).not.toHaveBeenCalled();
    expect(favoriteMutate).toHaveBeenCalledWith({ channelID: 'ch-1', favorite: false });
  });

  it('star aria-label switches between Favorite/Unfavorite based on state', async () => {
    await renderRow();
    expect(document.querySelector('[aria-label="Favorite general"]')).not.toBeNull();
    document.body.innerHTML = '';
    await renderRow({ ...baseChannel, favorite: true });
    expect(document.querySelector('[aria-label="Unfavorite general"]')).not.toBeNull();
  });

  it('renders a numeric unread badge, capping at 99+', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread unreadCount={150} onClose={() => {}} />
      </MemoryRouter>,
    );
    await expect.element(screen.getByTestId('channel-unread-badge-ch-1')).toHaveTextContent('99+');
  });

  it('renders the exact unread count when it is under 100', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread unreadCount={7} onClose={() => {}} />
      </MemoryRouter>,
    );
    await expect.element(screen.getByTestId('channel-unread-badge-ch-1')).toHaveTextContent('7');
  });

  it('suppresses navigation and notifies the consumer when suppressNavigation is set', async () => {
    const onClose = vi.fn();
    const onConsumed = vi.fn();
    await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread={false} onClose={onClose} suppressNavigation onSuppressNavigationConsumed={onConsumed} />
      </MemoryRouter>,
    );
    (document.querySelector('a[href="/channel/general"]') as HTMLAnchorElement).click();
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lists existing categories in the move menu and moves the channel on select', async () => {
    categoriesData.data = [{ id: 'cat-1', name: 'Work' }];
    const screen = await renderRow();
    await screen.getByTestId('row-menu-ch-1').click();
    const item = screen.getByText('Work');
    await expect.element(item).toBeVisible();
    await item.click();
    expect(setCategoryMutate).toHaveBeenCalledWith({ channelID: 'ch-1', categoryID: 'cat-1' });
  });
});
