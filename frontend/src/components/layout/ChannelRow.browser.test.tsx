import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { ChannelRow } from './ChannelRow';
import type { UserChannel } from '@/types';

const favoriteMutate = vi.hoisted(() => vi.fn());
const setCategoryMutate = vi.hoisted(() => vi.fn());
const categoriesData = vi.hoisted(() => ({ data: [] as { id: string; name: string }[] }));

vi.mock('@/hooks/useSidebar', () => ({
  useReorderSidebar: () => ({ mutate: vi.fn(), isPending: false }),
  markLocalSidebarReorder: vi.fn(),
  shouldRefetchSidebarForRemoteUpdate: vi.fn(() => true),
  resetSidebarReorderSessionState: vi.fn(),
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

// The kebab is a hover-reveal trigger on desktop and a hidden (long-press) menu
// on mobile. Open it the way a real user would per viewport so the row's menu
// items are reachable on every browser project.
async function openChannelMenu(screen: Awaited<ReturnType<typeof renderRow>>) {
  if (window.innerWidth <= 767) {
    const row = document.querySelector('[data-testid="channel-row-ch-1"]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await vi.waitFor(
      () => {
        expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
      },
      { timeout: 2000 },
    );
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
  } else {
    await screen.getByTestId('row-menu-ch-1').click();
    // The Radix dropdown mounts its items in a portal ASYNCHRONOUSLY. Wait for
    // the content (as the mobile branch does) so callers can query a specific
    // item without racing the open under full-suite CPU load.
    await vi.waitFor(
      () => {
        expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
      },
      { timeout: 2000 },
    );
  }
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

  it('renders a numeric alerted badge, capping at 99+', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread notifyCount={150} onClose={() => {}} />
      </MemoryRouter>,
    );
    await expect.element(screen.getByTestId('channel-unread-badge-ch-1')).toHaveTextContent('99+');
  });

  it('renders the exact alerted count when it is under 100', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread notifyCount={7} onClose={() => {}} />
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

  it('shows the availability dot when unread carries no alerts', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread notifyCount={0} onClose={() => {}} />
      </MemoryRouter>,
    );
    // Two-tier unread: plain activity is the dot; numbers are alerts only.
    await expect.element(screen.getByTestId('channel-unread-dot-ch-1')).toBeVisible();
    expect(document.querySelector('[data-testid="channel-unread-badge-ch-1"]')).toBeNull();
  });

  it('shows a subtle dot (not a badge) for a muted channel with quiet unread', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={{ ...baseChannel, muted: true }} hasUnread notifyCount={0} onClose={() => {}} />
      </MemoryRouter>,
    );
    await expect.element(screen.getByTestId('channel-unread-dot-ch-1')).toBeVisible();
    expect(document.querySelector('[data-testid="channel-unread-badge-ch-1"]')).toBeNull();
  });

  it('shows the numeric badge in a muted channel when a mention alerted', async () => {
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={{ ...baseChannel, muted: true }} hasUnread notifyCount={2} onClose={() => {}} />
      </MemoryRouter>,
    );
    // A mention overrides mute server-side; the alert stays loud here too.
    await expect.element(screen.getByTestId('channel-unread-badge-ch-1')).toHaveTextContent('2');
    expect(document.querySelector('[data-testid="channel-unread-dot-ch-1"]')).toBeNull();
  });

  it('moving a favorited channel into a category first removes the favorite', async () => {
    categoriesData.data = [{ id: 'cat-1', name: 'Work' }];
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={{ ...baseChannel, favorite: true }} hasUnread={false} onClose={() => {}} />
      </MemoryRouter>,
    );
    await openChannelMenu(screen);
    // Native click (not the auto-retrying locator click) so a still-settling
    // menu portal under full-suite CPU load can't hang it to the timeout.
    (screen.getByText('Work').element() as HTMLElement).click();
    // isFav → favorite(false) then setCategory(cat-1).
    await vi.waitFor(() => expect(favoriteMutate).toHaveBeenCalledWith({ channelID: 'ch-1', favorite: false }));
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
    await openChannelMenu(screen);
    // Only the built-in "Move to Channels" item renders (no categories).
    await expect.element(screen.getByText('Move to Channels')).toBeVisible();
  });

  it('lists existing categories in the move menu and moves the channel on select', async () => {
    categoriesData.data = [{ id: 'cat-1', name: 'Work' }];
    const screen = await renderRow();
    await openChannelMenu(screen);
    const item = screen.getByText('Work');
    await expect.element(item).toBeVisible();
    // Native click — avoids the actionability-retry hang under CPU load.
    (item.element() as HTMLElement).click();
    await vi.waitFor(() => expect(setCategoryMutate).toHaveBeenCalledWith({ channelID: 'ch-1', categoryID: 'cat-1' }));
  });

  it('opens the management menu via a mobile long-press (kebab is not a tap target)', async () => {
    if (window.innerWidth > 767) return;
    categoriesData.data = [{ id: 'cat-1', name: 'Work' }];
    const screen = await renderRow();
    // On mobile the kebab trigger is hidden and inert — it exists only so Radix
    // can anchor the menu; a long-press on the ROW is what opens it.
    const trigger = document.querySelector('[data-testid="row-menu-ch-1"]') as HTMLElement;
    expect(getComputedStyle(trigger).pointerEvents).toBe('none');

    const row = document.querySelector('[data-testid="channel-row-ch-1"]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await expect.element(screen.getByText('Move to Channels')).toBeVisible();
  });

  it('a short tap navigates (calls onClose) and does not open the menu on mobile', async () => {
    if (window.innerWidth > 767) return;
    const onClose = vi.fn();
    await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread={false} onClose={onClose} />
      </MemoryRouter>,
    );
    const row = document.querySelector('[data-testid="channel-row-ch-1"]') as HTMLElement;
    // Press + immediate release, well within the long-press delay.
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    (document.querySelector('a[href="/channel/general"]') as HTMLAnchorElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it('suppresses the navigation click that follows a long-press on mobile', async () => {
    if (window.innerWidth > 767) return;
    const onClose = vi.fn();
    const screen = await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread={false} onClose={onClose} />
      </MemoryRouter>,
    );
    const row = document.querySelector('[data-testid="channel-row-ch-1"]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await expect.element(screen.getByText('Move to Channels')).toBeVisible();
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    // The click a touch release fires must be swallowed — no navigation.
    const link = document.querySelector('a[href="/channel/general"]') as HTMLAnchorElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(onClose).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('mobile: the unread badge sits flush right in the kebab slot, clear of the star', async () => {
    if (window.innerWidth > 767) return;
    // Widest badge ("99+") so the geometry check covers the worst case.
    await render(
      <MemoryRouter>
        <ChannelRow channel={baseChannel} hasUnread notifyCount={150} onClose={() => {}} />
      </MemoryRouter>,
    );
    const badge = document.querySelector('[data-testid="channel-unread-badge-ch-1"]') as HTMLElement;
    const star = document.querySelector('[data-testid="fav-toggle-ch-1"]') as HTMLElement;
    const row = document.querySelector('[data-testid="channel-row-ch-1"]') as HTMLElement;
    const b = badge.getBoundingClientRect();
    const s = star.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    // The badge must NOT overlap the always-visible favorite star: it lives
    // fully to the right of it, in the slot the (mobile-hidden) kebab leaves.
    expect(b.left).toBeGreaterThanOrEqual(s.right);
    // …and it hugs the row's right edge (right-2 = 8px inset).
    expect(r.right - b.right).toBeLessThanOrEqual(10);
  });

  it('mobile: the muted unread dot also sits clear of the star', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter>
        <ChannelRow channel={{ ...baseChannel, muted: true }} hasUnread onClose={() => {}} />
      </MemoryRouter>,
    );
    const dot = document.querySelector('[data-testid="channel-unread-dot-ch-1"]') as HTMLElement;
    const star = document.querySelector('[data-testid="fav-toggle-ch-1"]') as HTMLElement;
    expect(dot.getBoundingClientRect().left).toBeGreaterThanOrEqual(star.getBoundingClientRect().right);
  });
});
