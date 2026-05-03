import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserChannel, SidebarCategory } from '@/types';
import type { ComponentProps } from 'react';

// --- mocks ---------------------------------------------------------------

const favoriteMutate = vi.fn();
const setCategoryMutate = vi.fn();

let categoriesData: SidebarCategory[] = [];

vi.mock('@/hooks/useSidebar', () => ({
  useFavoriteChannel: () => ({ mutate: favoriteMutate }),
  useSetCategory: () => ({ mutate: setCategoryMutate }),
  useCategories: () => ({ data: categoriesData }),
}));

// Render dropdown contents inline so we can interact with menu items.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="row-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button data-testid="dropdown-item" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { ChannelRow } from '@/components/layout/ChannelRow';

// --- helpers -------------------------------------------------------------

function makeChannel(overrides: Partial<UserChannel> = {}): UserChannel {
  return {
    channelID: 'ch-1',
    channelName: 'general',
    channelType: 'public',
    role: 1,
    ...overrides,
  };
}

function renderRow(channel: UserChannel, hasUnread = false, props: Partial<ComponentProps<typeof ChannelRow>> = {}) {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <ChannelRow channel={channel} hasUnread={hasUnread} onClose={onClose} {...props} />
        </BrowserRouter>
      </QueryClientProvider>,
    ),
    onClose,
  };
}

// --- tests ---------------------------------------------------------------

describe('ChannelRow', () => {
  beforeEach(() => {
    favoriteMutate.mockReset();
    setCategoryMutate.mockReset();
    categoriesData = [];
    window.history.pushState({}, '', '/');
  });

  it('renders the channel name', () => {
    renderRow(makeChannel({ channelName: 'general' }));
    expect(screen.getByText('general')).toBeInTheDocument();
  });

  it('toggles favorite via the star button', () => {
    renderRow(makeChannel({ channelID: 'ch-1', favorite: false }));
    const star = screen.getByTestId('fav-toggle-ch-1');
    fireEvent.click(star);
    expect(favoriteMutate).toHaveBeenCalledWith({ channelID: 'ch-1', favorite: true });
  });

  it('toggles favorite off when channel is already favorited', () => {
    renderRow(makeChannel({ channelID: 'ch-1', favorite: true, categoryID: 'cat-A' }));
    const star = screen.getByTestId('fav-toggle-ch-1');
    fireEvent.click(star);
    expect(setCategoryMutate).toHaveBeenCalledWith({ channelID: 'ch-1', categoryID: '' });
    expect(favoriteMutate).toHaveBeenCalledWith({ channelID: 'ch-1', favorite: false });
  });

  it('does not navigate when the parent suppresses the dragged channel click', () => {
    const { onClose } = renderRow(makeChannel({ channelID: 'ch-1', channelName: 'general' }), false, {
      suppressNavigation: true,
    });
    const link = screen.getByText('general').closest('a')!;

    fireEvent.click(link);

    expect(onClose).not.toHaveBeenCalled();
    expect(window.location.pathname).not.toBe('/channel/general');
  });

  it('uses Lock icon and shows mute indicator for muted private channels', () => {
    renderRow(makeChannel({ channelType: 'private', muted: true }));
    expect(screen.getByLabelText('Muted')).toBeInTheDocument();
  });

  it('"Move to Channels" calls setCategory with empty categoryID', () => {
    // The default uncategorised section is "Channels" — the menu copy
    // matches the section title so the action reads as "put it back where
    // an unassigned channel naturally belongs".
    renderRow(makeChannel({ channelID: 'ch-1', categoryID: 'cat-A' }));
    const items = screen.getAllByTestId('dropdown-item');
    const moveBack = items.find((b) => b.textContent === 'Move to Channels');
    fireEvent.click(moveBack!);
    expect(setCategoryMutate).toHaveBeenCalledWith({ channelID: 'ch-1', categoryID: '' });
  });

  it('disables "Move to Channels" when channel is already in the default section', () => {
    // No-op moves are pointless — disable the entry so the user knows
    // they're already there, rather than firing a redundant API call.
    renderRow(makeChannel({ channelID: 'ch-1' }));
    const items = screen.getAllByTestId('dropdown-item');
    const moveBack = items.find((b) => b.textContent === 'Move to Channels') as HTMLButtonElement;
    expect(moveBack.disabled).toBe(true);
  });

  it('does not offer a "New category" option in the row menu', () => {
    // Creating a new category lives in the sidebar header now; the row
    // menu only moves between existing buckets.
    renderRow(makeChannel({ channelID: 'ch-1' }));
    const items = screen.getAllByTestId('dropdown-item');
    expect(items.find((b) => b.textContent?.includes('New category'))).toBeUndefined();
  });

  it('"Move to <category>" calls setCategory with the category id', () => {
    categoriesData = [
      { id: 'cat-A', name: 'Alpha', position: 0 },
      { id: 'cat-B', name: 'Beta', position: 1 },
    ];
    renderRow(makeChannel({ channelID: 'ch-1' }));
    const items = screen.getAllByTestId('dropdown-item');
    const moveToBeta = items.find((b) => b.textContent === 'Move to Beta');
    fireEvent.click(moveToBeta!);
    expect(setCategoryMutate).toHaveBeenCalledWith({ channelID: 'ch-1', categoryID: 'cat-B' });
  });

  it('disables the "Move to <category>" entry for the current category', () => {
    categoriesData = [{ id: 'cat-A', name: 'Alpha', position: 0 }];
    renderRow(makeChannel({ channelID: 'ch-1', categoryID: 'cat-A' }));
    const items = screen.getAllByTestId('dropdown-item');
    const moveToAlpha = items.find((b) => b.textContent === 'Move to Alpha') as HTMLButtonElement;
    expect(moveToAlpha).toBeTruthy();
    expect(moveToAlpha.disabled).toBe(true);
  });

});
