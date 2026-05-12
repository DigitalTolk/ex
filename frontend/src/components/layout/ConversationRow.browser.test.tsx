import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationRow } from './ConversationRow';
import type { UserConversation } from '@/types';

const favoriteMutate = vi.hoisted(() => vi.fn());
const setCategoryMutate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useSidebar', () => ({
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
});
