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

  it('floors the unread badge to 1 when hasUnread but no live count is known', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread unreadCount={0} onClose={() => {}} />
      </MemoryRouter>,
    );
    // Any unread non-muted channel shows a NUMBER box (floored to 1) — no dot.
    await expect.element(screen.getByTestId('channel-unread-badge-ch-1')).toHaveTextContent('1');
    expect(document.querySelector('[data-testid="channel-unread-dot-ch-1"]')).toBeNull();
  });

  it('shows a subtle dot (not a badge) for a muted channel with unread', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={{ ...baseChannel, muted: true }} hasUnread unreadCount={5} onClose={() => {}} />
      </MemoryRouter>,
    );
    await expect.element(screen.getByTestId('channel-unread-dot-ch-1')).toBeVisible();
    expect(document.querySelector('[data-testid="channel-unread-badge-ch-1"]')).toBeNull();
  });

  it('moving a favorited channel into a category first removes the favorite', async () => {
    categoriesData.data = [{ id: 'cat-1', name: 'Work' }];
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={{ ...baseChannel, favorite: true }} hasUnread={false} onClose={() => {}} />
      </MemoryRouter>,
    );
    await screen.getByTestId('row-menu-ch-1').click();
    await screen.getByText('Work').click();
    // isFav → favorite(false) then setCategory(cat-1).
    expect(favoriteMutate).toHaveBeenCalledWith({ channelID: 'ch-1', favorite: false });
    expect(setCategoryMutate).toHaveBeenCalledWith({ channelID: 'ch-1', categoryID: 'cat-1' });
  });

  it('applies the grab cursor styling when draggable', async () => {
    const dragRef = vi.fn();
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread={false} onClose={() => {}} draggable dragRef={dragRef} />
      </MemoryRouter>,
    );
    const row = screen.getByTestId('channel-row-ch-1').element() as HTMLElement;
    expect(row.className).toContain('cursor-grab');
    expect(dragRef).toHaveBeenCalled();
  });

  it('calls onClose on a normal (non-suppressed) navigation click', async () => {
    const onClose = vi.fn();
    await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread={false} onClose={onClose} />
      </MemoryRouter>,
    );
    (document.querySelector('a[href="/channel/general"]') as HTMLAnchorElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks the row active when the current route matches the channel slug', async () => {
    await render(
      <MemoryRouter initialEntries={['/channel/general']}>
        <ChannelRow channel={baseChannel} hasUnread={false} onClose={() => {}} />
      </MemoryRouter>,
    );
    const link = document.querySelector('a[href="/channel/general"]') as HTMLElement;
    expect(link.className).toMatch(/bg-white\/15|font-semibold/);
  });

  it('renders the move menu when useCategories returns no data (?? [] fallback)', async () => {
    // categoriesData.data undefined → the `(categories ?? [])` empty-array arm.
    (categoriesData as { data: unknown }).data = undefined;
    const screen = await renderRow();
    await screen.getByTestId('row-menu-ch-1').click();
    // Only the built-in "Move to Channels" item renders (no categories).
    await expect.element(screen.getByText('Move to Channels')).toBeVisible();
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
