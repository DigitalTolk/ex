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
});
