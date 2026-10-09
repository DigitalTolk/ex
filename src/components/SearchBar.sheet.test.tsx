import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SearchBar } from './SearchBar';
import {
  addRecentSearch,
  loadRecentSearches,
  resetRecentSearchesSessionState,
  useRecentSearchesStore,
} from '@/stores/recent-searches';

const useChannelBySlugMock = vi.hoisted(() => vi.fn(() => ({ data: undefined as unknown })));
const useSearchMessagesMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ data: { hits: [] as unknown[] } as { hits: unknown[] } | undefined, isLoading: false })),
);

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: (slug?: string) => useChannelBySlugMock(slug as never),
  useUserChannels: () => ({ data: [] }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: [] }),
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useSearch', () => ({
  useSearchUsers: () => ({ data: { hits: [] }, isLoading: false }),
  useSearchChannels: () => ({ data: { hits: [] }, isLoading: false }),
  useSearchMessages: (...args: unknown[]) => useSearchMessagesMock(...args),
}));
vi.mock('@/hooks/useUsersBatch', () => ({ useUsersBatch: () => ({ map: new Map(), isLoading: false }) }));
vi.mock('@/context/PresenceContext', () => ({ usePresence: () => ({ online: new Set() }) }));
vi.mock('@/hooks/useDebouncedValue', () => ({ useDebouncedValue: (v: unknown) => v }));
vi.mock('@/components/search/MessageHitCard', () => ({
  MessageHitCard: ({ hit }: { hit: { id: string } }) => <a href={`#${hit.id}`} data-testid="message-hit-card">{hit.id}</a>,
}));

let lastLocation = '/';
function LocationProbe() {
  const loc = useLocation();
  useEffect(() => {
    lastLocation = loc.pathname + loc.search;
  }, [loc.pathname, loc.search]);
  return null;
}

function renderSheet(path = '/', onDone = vi.fn(), variant: 'sheet' | 'bar' = 'sheet') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SearchBar variant={variant} onDone={onDone} leading={<span data-testid="leading" />} />
      <LocationProbe />
    </MemoryRouter>,
  );
  return onDone;
}

beforeEach(() => {
  act(() => {
    resetRecentSearchesSessionState();
    loadRecentSearches('u-1');
  });
  useChannelBySlugMock.mockReturnValue({ data: undefined });
  useSearchMessagesMock.mockReset();
  useSearchMessagesMock.mockReturnValue({ data: { hits: [] }, isLoading: false });
  lastLocation = '/';
});

describe('SearchBar sheet variant', () => {
  it('shows just the field (no hint copy) with no recent searches, and the leading slot', () => {
    renderSheet();
    expect(screen.queryByTestId('recent-searches')).not.toBeInTheDocument();
    expect(screen.queryByText(/Search messages, channels and people/)).not.toBeInTheDocument();
    expect(screen.getByTestId('leading')).toBeInTheDocument();
  });

  it('lists recent searches; tapping one runs it in place, × removes one, Clear removes all', () => {
    act(() => {
      addRecentSearch('standup');
      addRecentSearch('release');
    });
    useSearchMessagesMock.mockReturnValue({ data: { hits: [{ id: 'm1' }] }, isLoading: false });
    renderSheet();
    const rows = screen.getAllByTestId('recent-search');
    expect(rows.map((r) => r.textContent)).toEqual(['release', 'standup']);
    fireEvent.click(rows[1]);
    expect(screen.getByTestId('searchbar-input')).toHaveValue('standup');
    expect(screen.getByTestId('message-hit-card')).toBeInTheDocument();
    expect(lastLocation).toBe('/');
    expect(useRecentSearchesStore.getState().queries[0]).toBe('standup');
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove release from recent searches' }));
    expect(useRecentSearchesStore.getState().queries).toEqual(['standup']);
    fireEvent.click(screen.getByTestId('recent-searches-clear'));
    expect(useRecentSearchesStore.getState().queries).toEqual([]);
  });

  it('runs a message search in place, records it, and closes when a result is opened', () => {
    useSearchMessagesMock.mockReturnValue({ data: { hits: [{ id: 'm1' }, { id: 'm2' }] }, isLoading: false });
    const onDone = renderSheet();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'release' } });
    // Not run yet: the live action shows instead of results.
    expect(screen.queryByTestId('sheet-message-results')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('searchbar-show-results'));
    expect(screen.getAllByTestId('message-hit-card')).toHaveLength(2);
    expect(useRecentSearchesStore.getState().queries).toEqual(['release']);
    expect(lastLocation).toBe('/');
    expect(useSearchMessagesMock).toHaveBeenLastCalledWith('release', true, 20, undefined);
    // The results are their own section, not options of the suggestion list.
    expect(screen.getByTestId('sheet-message-results').closest('[role="listbox"]')).toBeNull();
    fireEvent.click(screen.getAllByTestId('message-hit-card')[0]);
    expect(onDone).toHaveBeenCalled();
    // Editing the text goes back to the live suggestions.
    fireEvent.change(input, { target: { value: 'release notes' } });
    expect(screen.queryByTestId('sheet-message-results')).not.toBeInTheDocument();
    expect(screen.getByTestId('searchbar-show-results')).toBeInTheDocument();
  });

  it('scopes an in-channel search and shows loading, then an empty result', () => {
    useChannelBySlugMock.mockReturnValue({ data: { id: 'ch-1', name: 'general' } });
    useSearchMessagesMock.mockReturnValue({ data: undefined, isLoading: true });
    renderSheet('/channel/general');
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'deploy' } });
    fireEvent.click(screen.getByTestId('searchbar-show-in-scope'));
    expect(useSearchMessagesMock).toHaveBeenLastCalledWith('deploy', true, 20, { in: 'ch-1' });
    expect(screen.queryByTestId('message-hit-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sheet-message-empty')).not.toBeInTheDocument();
  });

  it('says so when nothing matches; Enter runs it too', () => {
    renderSheet();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('sheet-message-empty')).toHaveTextContent('No messages match “zzz”.');
    expect(screen.queryByTestId('sheet-all-results')).not.toBeInTheDocument();
  });

  // Only opening a result closes the sheet: a tap on the empty state, a
  // placeholder or a result that can't open used to close it with nowhere
  // to go.
  it('stays open for taps that do not open anything', () => {
    const onDone = renderSheet();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('sheet-message-empty'));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('opens the full search page from All results, keeping the scope', () => {
    useChannelBySlugMock.mockReturnValue({ data: { id: 'ch-1', name: 'general' } });
    useSearchMessagesMock.mockReturnValue({ data: { hits: [{ id: 'm1' }] }, isLoading: false });
    const onDone = renderSheet('/channel/general');
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'deploy' } });
    fireEvent.click(screen.getByTestId('searchbar-show-in-scope'));
    fireEvent.click(screen.getByTestId('sheet-all-results'));
    // On the tab that matches the scope, as the desktop bar lands — the sheet
    // used to drop the kind and land a channel-scoped search on All.
    expect(lastLocation).toBe('/search?q=deploy&in=ch-1&type=messages');
    expect(onDone).toHaveBeenCalled();
  });

  it('opens the full search page unscoped', () => {
    useSearchMessagesMock.mockReturnValue({ data: { hits: [{ id: 'm1' }] }, isLoading: false });
    renderSheet();
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'deploy' } });
    fireEvent.click(screen.getByTestId('searchbar-show-results'));
    fireEvent.click(screen.getByTestId('sheet-all-results'));
    expect(lastLocation).toBe('/search?q=deploy');
  });

  // Only the sheet shows recent searches, so only the sheet records them.
  it('does not record searches made from the desktop bar', () => {
    renderSheet('/', vi.fn(), 'bar');
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'quarterly' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lastLocation).toBe('/search?q=quarterly');
    expect(useRecentSearchesStore.getState().queries).toEqual([]);
  });

  it('does not take over ⌘K or close on outside clicks', () => {
    const onDone = renderSheet();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('searchbar-input')).not.toHaveFocus();
    fireEvent.mouseDown(document.body);
    expect(onDone).not.toHaveBeenCalled();
  });
});
