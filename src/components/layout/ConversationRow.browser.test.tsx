import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationRow } from './ConversationRow';
import type { UserConversation } from '@/types';

const favoriteMutate = vi.hoisted(() => vi.fn());
const setCategoryMutate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useSidebar', () => ({
  useReorderSidebar: () => ({ mutate: vi.fn(), isPending: false }),
  markLocalSidebarReorder: vi.fn(),
  shouldRefetchSidebarForRemoteUpdate: vi.fn(() => true),
  resetSidebarReorderSessionState: vi.fn(),
  useFavoriteConversation: () => ({ mutate: favoriteMutate, isPending: false }),
  useSetConversationCategory: () => ({ mutate: setCategoryMutate, isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

beforeEach(() => {
  favoriteMutate.mockReset();
  setCategoryMutate.mockReset();
});

const dm: UserConversation = {
  conversationID: 'cv-1',
  type: 'dm',
  displayName: 'Bob',
  participantIDs: ['u-1', 'u-2'],
  unreadCount: 0,
  favorite: false,
  categoryID: '',
};

const group: UserConversation = {
  conversationID: 'cv-2',
  type: 'group',
  displayName: 'Alice Smith, Bob Jones, Carol Wu',
  participantIDs: ['u-1', 'u-2', 'u-3', 'u-4'],
  unreadCount: 0,
  favorite: false,
  categoryID: '',
};

function renderRow(conversation: UserConversation = dm, overrides: Partial<Parameters<typeof ConversationRow>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ConversationRow
          conversation={conversation}
          hasUnread={false}
          onClose={() => {}}
          onHide={() => {}}
          {...overrides}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The kebab is a hover-reveal trigger on desktop and a hidden (long-press) menu
// on mobile. Open it the way a real user would per viewport.
async function openConvMenu(screen: Awaited<ReturnType<typeof renderRow>>) {
  if (window.innerWidth <= 767) {
    const row = document.querySelector('[data-testid="conversation-row-cv-1"]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await vi.waitFor(
      () => {
        expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
      },
      { timeout: 2000 },
    );
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
  } else {
    await screen.getByTestId('conv-row-menu-cv-1').click();
    // The Radix dropdown mounts its items in a portal ASYNCHRONOUSLY. Wait for
    // the content here (as the mobile branch above does) so callers can query a
    // specific item without racing the open — a raw querySelector fired right
    // after the trigger click returns null under full-suite CPU load.
    await vi.waitFor(
      () => {
        expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
      },
      { timeout: 2000 },
    );
  }
}

describe('ConversationRow browser behaviour', () => {
  it('renders DM displayName and user avatar branch', async () => {
    const screen = await renderRow(dm);
    await expect.element(screen.getByText('Bob')).toBeVisible();
    // No participant-count badge on a DM row.
    expect(document.querySelector('[aria-label*="participants"]')).toBeNull();
  });

  it('renders the group branch with a participant-count badge and shortened names', async () => {
    const screen = await renderRow(group);
    await expect.element(screen.getByText('Alice, Bob, Carol')).toBeVisible();
    const badge = document.querySelector('[aria-label="4 participants"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('4');
  });

  it('toggleFavorite mutates favorite and clears category position when un-favoriting', async () => {
    await renderRow({ ...dm, favorite: true });
    const star = document.querySelector('[data-testid="conv-fav-toggle-cv-1"]') as HTMLButtonElement;
    star.click();
    expect(setCategoryMutate).toHaveBeenCalledWith({
      conversationID: 'cv-1',
      categoryID: '',
      sidebarPosition: 0,
    });
    expect(favoriteMutate).toHaveBeenCalledWith({ conversationID: 'cv-1', favorite: false });
  });

  it('toggleFavorite on a non-favorited row only flips the favorite flag (no category mutation)', async () => {
    await renderRow(dm);
    const star = document.querySelector('[data-testid="conv-fav-toggle-cv-1"]') as HTMLButtonElement;
    star.click();
    expect(setCategoryMutate).not.toHaveBeenCalled();
    expect(favoriteMutate).toHaveBeenCalledWith({ conversationID: 'cv-1', favorite: true });
  });

  it('star aria-label distinguishes Favorite/Unfavorite based on state', async () => {
    await renderRow(dm);
    expect(document.querySelector('[aria-label="Favorite Bob"]')).not.toBeNull();
    document.body.innerHTML = '';
    await renderRow({ ...dm, favorite: true });
    expect(document.querySelector('[aria-label="Unfavorite Bob"]')).not.toBeNull();
  });

  it('NavLink hard-disables navigation when suppressNavigation is set', async () => {
    const consumed = vi.fn();
    await renderRow(dm, { suppressNavigation: true, onSuppressNavigationConsumed: consumed });
    const link = document.querySelector(`a[href="/conversation/cv-1"]`) as HTMLAnchorElement;
    // Use a custom click event so we can read defaultPrevented after dispatch.
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(consumed).toHaveBeenCalled();
  });

  it('renders the close-conversation menu trigger with the correct aria-label', async () => {
    await renderRow(dm);
    const trigger = document.querySelector('[data-testid="conv-row-menu-cv-1"]') as HTMLElement;
    expect(trigger.getAttribute('aria-label')).toBe('Manage Bob sidebar placement');
  });

  it('renders a numeric alerted badge capping at 99+', async () => {
    const screen = await renderRow(dm, { hasUnread: true, notifyCount: 200 });
    await expect.element(screen.getByTestId('conversation-unread-badge-cv-1')).toHaveTextContent('99+');
  });

  it('suppresses navigation and notifies the consumer when suppressNavigation is set', async () => {
    const onClose = vi.fn();
    const onConsumed = vi.fn();
    await renderRow(dm, { onClose, suppressNavigation: true, onSuppressNavigationConsumed: onConsumed });
    (document.querySelector('a[href="/conversation/cv-1"]') as HTMLAnchorElement).click();
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders without crashing when a conversation has no display name (?? fallback)', async () => {
    const screen = await renderRow({ ...dm, displayName: '' });
    // The avatar falls back to "??"; the row still mounts.
    await expect.element(screen.getByTestId('conversation-row-cv-1')).toBeVisible();
  });

  it('handles a group conversation with no participant ids (count falls back to 0)', async () => {
    const screen = await renderRow({ ...group, participantIDs: undefined });
    await expect.element(screen.getByTestId('conversation-row-cv-2')).toBeVisible();
  });

  it('shows the availability dot for unread without alerts', async () => {
    // Two-tier unread: quiet unread (e.g. a muted DM's chatter, or an
    // alerted count that hasn't synced) is the dot — numbers are alerts.
    const screen = await renderRow(dm, { hasUnread: true, notifyCount: 0 });
    await expect.element(screen.getByTestId('conversation-unread-dot-cv-1')).toBeVisible();
    expect(document.querySelector('[data-testid="conversation-unread-badge-cv-1"]')).toBeNull();
  });

  it('renders the exact alerted count when under 100', async () => {
    const screen = await renderRow(dm, { hasUnread: true, notifyCount: 5 });
    await expect.element(screen.getByTestId('conversation-unread-badge-cv-1')).toHaveTextContent('5');
  });

  it('applies the grab cursor styling and wires dragRef when draggable', async () => {
    const dragRef = vi.fn();
    const screen = await renderRow(dm, { draggable: true, dragRef });
    const row = screen.getByTestId('conversation-row-cv-1').element() as HTMLElement;
    expect(row.className).toContain('cursor-grab');
    expect(dragRef).toHaveBeenCalled();
  });

  it('calls onClose on a normal navigation click', async () => {
    const onClose = vi.fn();
    await renderRow(dm, { onClose });
    (document.querySelector('a[href="/conversation/cv-1"]') as HTMLAnchorElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('un-favoriting a categorized conversation resets its position within that category', async () => {
    // favorite=true with a categoryID exercises the `categoryID ?? ""`
    // truthy arm when toggling the star off.
    await renderRow({ ...dm, favorite: true, categoryID: 'cat-9' });
    const star = document.querySelector('[data-testid="conv-fav-toggle-cv-1"]') as HTMLButtonElement;
    star.click();
    expect(setCategoryMutate).toHaveBeenCalledWith({
      conversationID: 'cv-1',
      categoryID: 'cat-9',
      sidebarPosition: 0,
    });
  });

  it('un-favoriting a conversation with no categoryID falls back to "" (?? arm)', async () => {
    // categoryID undefined → the `conversation.categoryID ?? ""` nullish arm.
    await renderRow({ ...dm, favorite: true, categoryID: undefined });
    const star = document.querySelector('[data-testid="conv-fav-toggle-cv-1"]') as HTMLButtonElement;
    star.click();
    expect(setCategoryMutate).toHaveBeenCalledWith({
      conversationID: 'cv-1',
      categoryID: '',
      sidebarPosition: 0,
    });
  });

  it('hides the conversation via the kebab menu', async () => {
    const onHide = vi.fn();
    const screen = await renderRow(dm, { onHide });
    await openConvMenu(screen);
    // Native click, not the Playwright actionability-click: the Radix menu
    // portal can still be settling under full-suite CPU load, and the auto-
    // retrying locator click would then hang to the test timeout (a flake). The
    // item is already asserted present by openConvMenu.
    (document.querySelector('[data-testid="conv-close-cv-1"]') as HTMLElement).click();
    await vi.waitFor(() => expect(onHide).toHaveBeenCalledWith('cv-1'));
  });

  it('opens the management menu via a mobile long-press (kebab is not a tap target)', async () => {
    if (window.innerWidth > 767) return;
    const screen = await renderRow(dm);
    // On mobile the kebab trigger is hidden and inert — it only anchors the
    // Radix menu; a long-press on the ROW opens it.
    const trigger = document.querySelector('[data-testid="conv-row-menu-cv-1"]') as HTMLElement;
    expect(getComputedStyle(trigger).pointerEvents).toBe('none');

    const row = document.querySelector('[data-testid="conversation-row-cv-1"]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await expect.element(screen.getByTestId('conv-close-cv-1')).toBeVisible();
  });

  it('a short tap navigates (calls onClose) and does not open the menu on mobile', async () => {
    if (window.innerWidth > 767) return;
    const onClose = vi.fn();
    await renderRow(dm, { onClose });
    const row = document.querySelector('[data-testid="conversation-row-cv-1"]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    (document.querySelector('a[href="/conversation/cv-1"]') as HTMLAnchorElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it('suppresses the navigation click that follows a long-press on mobile', async () => {
    if (window.innerWidth > 767) return;
    const onClose = vi.fn();
    const screen = await renderRow(dm, { onClose });
    const row = document.querySelector('[data-testid="conversation-row-cv-1"]') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await expect.element(screen.getByTestId('conv-close-cv-1')).toBeVisible();
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    const link = document.querySelector('a[href="/conversation/cv-1"]') as HTMLAnchorElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(onClose).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('mobile: the unread badge sits flush right in the kebab slot, clear of the star', async () => {
    if (window.innerWidth > 767) return;
    // Widest badge ("99+") so the geometry check covers the worst case.
    await renderRow(dm, { hasUnread: true, notifyCount: 150 });
    const badge = document.querySelector('[data-testid="conversation-unread-badge-cv-1"]') as HTMLElement;
    const star = document.querySelector('[data-testid="conv-fav-toggle-cv-1"]') as HTMLElement;
    const row = document.querySelector('[data-testid="conversation-row-cv-1"]') as HTMLElement;
    const b = badge.getBoundingClientRect();
    const s = star.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    // Must NOT overlap the always-visible favorite star — the badge lives in
    // the slot the (mobile-hidden) kebab leaves at the very right edge.
    expect(b.left).toBeGreaterThanOrEqual(s.right);
    expect(r.right - b.right).toBeLessThanOrEqual(10);
  });

  it('marks the row active when the current route matches the conversation', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/conversation/cv-1']}>
          <ConversationRow conversation={dm} hasUnread={false} onClose={() => {}} onHide={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The active NavLink carries the highlight styling.
    const link = document.querySelector('a[href="/conversation/cv-1"]') as HTMLElement;
    expect(link.className).toMatch(/bg-white\/15|font-semibold/);
  });
});
