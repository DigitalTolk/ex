import { Profiler, useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { SearchBar } from './SearchBar';
import { usePresenceStore } from '@/stores/presence';
import {
  addRecentOpened,
  addRecentSearch,
  loadRecentSearches,
  resetRecentSearchesSessionState,
  useRecentSearchesStore,
} from '@/stores/recent-searches';

const useChannelBySlugMock = vi.hoisted(() => vi.fn(() => ({ data: undefined as unknown })));
const useUserChannelsMock = vi.hoisted(() => vi.fn(() => ({ data: [] as { channelID: string }[] })));
const useUserConversationsMock = vi.hoisted(() => vi.fn(() => ({ data: [] as unknown[] })));
// openDM defaults to the success path: run the caller's onSuccess (which
// resets the bar); navigation itself is the hook's job and is covered by
// the useOpenDM hook tests.
const openDMMock = vi.hoisted(() =>
  vi.fn((_userID: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
);
const useSearchUsersMock = vi.hoisted(() =>
  vi.fn(() => ({ data: { hits: [] as unknown[] }, isLoading: false })),
);
const useSearchChannelsMock = vi.hoisted(() =>
  vi.fn(() => ({ data: { hits: [] as unknown[] }, isLoading: false })),
);
const useUsersBatchMock = vi.hoisted(() =>
  vi.fn(() => ({ map: new Map<string, { avatarURL?: string }>(), isLoading: false })),
);

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: (slug?: string) => useChannelBySlugMock(slug as never),
  useUserChannels: () => useUserChannelsMock(),
}));
vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => useUserConversationsMock(),
  useOpenDM: () => ({ openDM: openDMMock, isPending: false }),
}));
vi.mock('@/hooks/useSearch', () => ({
  // The sheet variant's message search; unused by the top-bar field.
  useSearchMessages: () => ({ data: undefined, isLoading: false }),
  useSearchUsers: (...args: unknown[]) => useSearchUsersMock(...(args as [])),
  useSearchChannels: (...args: unknown[]) => useSearchChannelsMock(...(args as [])),
}));
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: (...args: unknown[]) => useUsersBatchMock(...(args as [])),
}));
// UserStatusIndicator resolves custom emojis through React Query; the bar test
// renders no QueryClient, so stub the map (unicode emojis render directly).
vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));
// Debounce is identity in tests so search results appear synchronously.
vi.mock('@/hooks/useDebouncedValue', () => ({
  useDebouncedValue: (v: unknown) => v,
}));

let lastLocation: { pathname: string; search: string } = { pathname: '/', search: '' };
function LocationProbe() {
  const loc = useLocation();
  useEffect(() => {
    lastLocation = { pathname: loc.pathname, search: loc.search };
  }, [loc.pathname, loc.search]);
  return null;
}

// The roster from: suggests, as the app's cache holds it.
const ROSTER = [
  { id: 'u-carol', displayName: 'Carol Ng', email: 'carol@example.com' },
  { id: 'u-cass', displayName: 'Cass Wu', email: 'cw@example.com' },
  { id: 'u-bob', displayName: 'Bob Ray', email: 'bob@example.com' },
];

function renderBar(initialPath = '/') {
  // The app always has a query client; the bar's own roster query (from:
  // suggestions) reads from it.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(queryKeys.allUsers(), ROSTER);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SearchBar />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useChannelBySlugMock.mockReturnValue({ data: undefined });
  useUserChannelsMock.mockReturnValue({ data: [] });
  useUserConversationsMock.mockReturnValue({ data: [] });
  useSearchUsersMock.mockReturnValue({ data: { hits: [] }, isLoading: false });
  useSearchChannelsMock.mockReturnValue({ data: { hits: [] }, isLoading: false });
  useUsersBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
  openDMMock.mockClear();
  openDMMock.mockImplementation((_userID, opts) => opts?.onSuccess?.());
  lastLocation = { pathname: '/', search: '' };
});

// Force a specific platform for the shortcut chord. jsdom's default UA
// contains neither "mac" nor "windows", so the non-Apple branch is the
// ambient default; Apple behavior is opted into per test.
function stubUserAgent(ua: string) {
  const spy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
  return () => spy.mockRestore();
}

describe('SearchBar', () => {
  it('opens the dropdown on input and closes it on an outside mousedown', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();

    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
  });

  it('keeps the dropdown open on a mousedown inside the container', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    act(() => {
      fireEvent.mouseDown(input);
    });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
  });

  it('ignores ArrowUp/ArrowDown while the list is closed', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' }); // closed, still focused
    expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(true);
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('cycles the highlight with ArrowDown/ArrowUp when suggestions exist', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('searchbar-show-results').getAttribute('aria-selected')).toBe('true');
  });

  it('ignores a neutral keydown that matches none of the navigation keys', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('searchbar-show-results').getAttribute('aria-selected')).toBe('true');
  });

  it('highlights the messages action on hover and submits it on click', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'meeting notes' } });
    const suggestion = screen.getByTestId('searchbar-show-results');
    fireEvent.mouseEnter(suggestion);
    expect(suggestion.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(suggestion);
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
    expect(lastLocation.pathname).toBe('/search');
    expect(lastLocation.search).toContain('q=meeting+notes');
  });

  it('closes on Escape', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'x' } });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
  });

  it('Enter with a whitespace-only query does not submit', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lastLocation.pathname).toBe('/');
  });

  it('clear button empties the input', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    fireEvent.click(screen.getByLabelText('Clear search'));
    expect(input.value).toBe('');
  });

  describe('recent list on an empty field', () => {
    beforeEach(() => {
      act(() => {
        resetRecentSearchesSessionState();
        loadRecentSearches('u-1');
        addRecentSearch('standup');
        addRecentOpened({ kind: 'user', id: 'u-bob', name: 'Bob' });
        addRecentOpened({ kind: 'group', id: 'g-7', name: 'Bob, Carol' });
        addRecentOpened({ kind: 'channel', id: 'c-1', slug: 'general', name: 'general', private: false });
      });
    });

    // The recent rows, below the search options.
    const recentOptions = () => screen.getAllByRole('option').filter((o) => !o.getAttribute('data-testid')?.startsWith('search-option-'));
    const rows = () => recentOptions().map((o) => o.textContent);

    it('lists what was opened, then recent searches, when the empty field gets focus', () => {
      renderBar();
      expect(screen.queryByTestId('recent-searches')).toBeNull();
      fireEvent.focus(screen.getByTestId('searchbar-input'));
      expect(screen.getByRole('listbox', { name: 'Recent' })).toBeInTheDocument();
      expect(rows()).toEqual(['~general', 'Bob, Carol', 'Bob', 'standup']);
      // The search options come first; the first recent row is the one
      // Enter opens.
      expect(screen.getByRole('group', { name: 'Search options' })).toHaveTextContent('from:Messages from a personin:Messages in a channel or DM');
      expect(recentOptions()[0]).toHaveAttribute('aria-selected', 'true');
      // Typing swaps it for live results.
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'gen' } });
      expect(screen.queryByTestId('recent-searches')).toBeNull();
    });

    it('Enter opens the highlighted channel and moves it to the top', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/conversation/g-7');
      expect(useRecentSearchesStore.getState().opened[0]).toEqual({ kind: 'group', id: 'g-7', name: 'Bob, Carol' });
      expect(screen.queryByTestId('recent-searches')).toBeNull();
    });

    it('Enter on the person opens their DM, a click opens the channel, a recent search goes to the search page', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(openDMMock).toHaveBeenCalledWith('u-bob', expect.anything());
      fireEvent.focus(input);
      fireEvent.click(screen.getAllByTestId('recent-opened').find((r) => r.textContent?.startsWith('~general'))!);
      expect(lastLocation.pathname).toBe('/channel/general');
      fireEvent.focus(input);
      fireEvent.click(screen.getByTestId('recent-search'));
      expect(lastLocation).toEqual({ pathname: '/search', search: '?q=standup' });
    });

    it('ArrowUp past the search options wraps to the recent search, and Enter runs it', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(screen.getByTestId('search-option-in')).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation).toEqual({ pathname: '/search', search: '?q=standup' });
    });

    it('hovering moves the highlight; × forgets one and Clear empties a section, keeping the list open', () => {
      renderBar();
      fireEvent.focus(screen.getByTestId('searchbar-input'));
      fireEvent.mouseEnter(screen.getAllByTestId('recent-opened')[2].parentElement!);
      expect(recentOptions()[2]).toHaveAttribute('aria-selected', 'true');
      fireEvent.mouseEnter(screen.getByTestId('recent-search').parentElement!);
      expect(screen.getByTestId('recent-search')).toHaveAttribute('aria-selected', 'true');
      const remove = screen.getByRole('button', { name: 'Remove ~general from recently opened' });
      expect(fireEvent.mouseDown(remove)).toBe(false); // keeps the field focused
      fireEvent.click(remove);
      expect(rows()).toEqual(['Bob, Carol', 'Bob', 'standup']);
      fireEvent.click(screen.getByRole('button', { name: 'Remove standup from recent searches' }));
      expect(screen.queryByTestId('recent-searches-clear')).toBeNull();
      const clear = screen.getByTestId('recent-opened-clear');
      expect(fireEvent.mouseDown(clear)).toBe(false);
      fireEvent.click(clear);
      // Only the search options are left.
      expect(rows()).toEqual([]);
      expect(screen.getByTestId('search-option-from')).toBeInTheDocument();
    });

    it('shows just the search options with no history, none picked until arrowed to', () => {
      act(() => resetRecentSearchesSessionState());
      renderBar();
      const field = screen.getByTestId('searchbar-input') as HTMLInputElement;
      fireEvent.focus(field);
      expect(rows()).toEqual([]);
      expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-testid'))).toEqual(['search-option-from', 'search-option-in']);
      expect(screen.getAllByRole('option').every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true);
      expect(field).not.toHaveAttribute('aria-activedescendant');
      // Enter alone does nothing; the arrows pick an option from either end.
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(field.value).toBe('');
      fireEvent.keyDown(field, { key: 'ArrowUp' });
      expect(screen.getByTestId('search-option-in')).toHaveAttribute('aria-selected', 'true');
      fireEvent.mouseEnter(screen.getByTestId('search-option-from'));
      expect(screen.getByTestId('search-option-from')).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(field.value).toBe('from:');
    });

    it('ArrowDown with nothing picked starts at the first search option', () => {
      act(() => resetRecentSearchesSessionState());
      renderBar();
      const field = screen.getByTestId('searchbar-input') as HTMLInputElement;
      fireEvent.focus(field);
      fireEvent.keyDown(field, { key: 'ArrowDown' });
      expect(screen.getByTestId('search-option-from')).toHaveAttribute('aria-selected', 'true');
    });
  });

  // Mattermost-style modifiers: typing from: or in: lists who or where, and
  // picking one completes the word.
  describe('search options', () => {
    const input = () => screen.getByTestId('searchbar-input') as HTMLInputElement;
    // A row's text, without the Tab hint the highlighted one carries.
    const options = () => screen.getAllByTestId('search-modifier-option').map((o) => o.textContent?.replace(/Tab$/, ''));

    it('starts a from: from the empty field, then suggests people as it is typed', () => {
      renderBar();
      fireEvent.focus(input());
      expect(fireEvent.mouseDown(screen.getByTestId('search-option-from'))).toBe(false); // keeps the field focused
      fireEvent.click(screen.getByTestId('search-option-from'));
      expect(input().value).toBe('from:');
      expect(options()).toEqual(['Bob Raybob@example.com', 'Carol Ngcarol@example.com', 'Cass Wucw@example.com']);
      fireEvent.change(input(), { target: { value: 'from:ca' } });
      expect(screen.getByRole('group', { name: 'From' })).toBeInTheDocument();
      expect(options()).toEqual(['Carol Ngcarol@example.com', 'Cass Wucw@example.com']);
      // The plain search rows step aside while a modifier is being typed.
      expect(screen.queryByTestId('searchbar-show-results')).toBeNull();
    });

    it('Tab or Enter takes the highlighted name, ArrowDown and hover move it, a click takes one too', () => {
      renderBar();
      fireEvent.change(input(), { target: { value: 'deploy from:ca' } });
      expect(screen.getAllByTestId('search-modifier-option')[0]).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(input(), { key: 'Tab' });
      expect(input().value).toBe('deploy from:Carol ');
      fireEvent.change(input(), { target: { value: 'deploy from:ca' } });
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(input().value).toBe('deploy from:Cass ');
      fireEvent.change(input(), { target: { value: 'from:"carol n' } });
      fireEvent.mouseEnter(screen.getAllByTestId('search-modifier-option')[0]);
      expect(fireEvent.mouseDown(screen.getAllByTestId('search-modifier-option')[0])).toBe(false); // keeps the field focused
      fireEvent.click(screen.getAllByTestId('search-modifier-option')[0]);
      expect(input().value).toBe('from:Carol ');
      // Then the words, and Enter searches it all.
      fireEvent.change(input(), { target: { value: 'from:Carol deploy' } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(lastLocation).toEqual({ pathname: '/search', search: '?q=from%3ACarol+deploy' });
    });

    it('suggests channels and DMs for in:', () => {
      useUserChannelsMock.mockReturnValue({
        data: [
          { channelID: 'c-1', channelName: 'general', channelType: 'public' },
          { channelID: 'c-2', channelName: 'gen-z', channelType: 'private' },
        ],
      } as never);
      useUserConversationsMock.mockReturnValue({ data: [{ conversationID: 'd-1', displayName: 'Gene Hall', type: 'dm' }] });
      renderBar();
      fireEvent.change(input(), { target: { value: 'in:~gen' } });
      expect(screen.getByRole('group', { name: 'In' })).toBeInTheDocument();
      // Ordered by name, channels and DMs together.
      expect(options()).toEqual(['~gen-z', 'Gene Hall', '~general']);
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(input().value).toBe('in:~gen-z ');
      fireEvent.change(input(), { target: { value: 'in:gene' } });
      fireEvent.keyDown(input(), { key: 'Tab' });
      expect(input().value).toBe('in:"Gene Hall" ');
    });

    // Regression: with a channel hit around, typing "from:" rendered that
    // channel's row while the list held only the people, and the bar crashed
    // the page. The lookups leave the modifier being typed out.
    it('does not crash on from: with channel and people hits around, nor look them up for it', () => {
      useSearchChannelsMock.mockReturnValue({ data: { hits: [{ id: 'c-from', score: 1, _source: { name: 'from-the-field', slug: 'from-the-field' } }] }, isLoading: false });
      useSearchUsersMock.mockReturnValue({ data: { hits: [{ id: 'u-x', score: 1, _source: { displayName: 'Fromm' } }] }, isLoading: false });
      renderBar();
      fireEvent.change(input(), { target: { value: 'deploy from:' } });
      expect(options()).toHaveLength(3);
      expect(screen.queryByRole('group', { name: 'Channels' })).toBeNull();
      expect(screen.queryByRole('group', { name: 'People' })).toBeNull();
      expect(useSearchChannelsMock).not.toHaveBeenCalledWith(expect.stringContaining('from'), expect.anything(), expect.anything());
    });

    it('suggests days for on:, before: and after:, and writes the one picked', () => {
      renderBar();
      fireEvent.change(input(), { target: { value: 'deploy on:' } });
      expect(screen.getByRole('group', { name: 'On' })).toBeInTheDocument();
      expect(options().slice(0, 2).map((o) => o?.split(/(?=[A-Z][a-z]{2},)/)[0])).toEqual(['Today', 'Yesterday']);
      expect(options()).toHaveLength(7);
      fireEvent.keyDown(input(), { key: 'Tab' });
      expect(input().value).toBe('deploy on:today ');
      fireEvent.change(input(), { target: { value: 'deploy before:yes' } });
      expect(screen.getByRole('group', { name: 'Before' })).toBeInTheDocument();
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(input().value).toBe('deploy before:yesterday ');
      fireEvent.change(input(), { target: { value: 'after:20' } });
      expect(screen.getByRole('group', { name: 'After' })).toBeInTheDocument();
      // A whole date typed out is done: no list, and Enter searches it.
      fireEvent.change(input(), { target: { value: 'deploy after:2025-01-31' } });
      expect(screen.queryByRole('group', { name: 'After' })).toBeNull();
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(lastLocation).toEqual({ pathname: '/search', search: '?q=deploy+after%3A2025-01-31' });
    });

    it('falls back to the plain search when nothing matches, and Tab is left alone', () => {
      renderBar();
      fireEvent.change(input(), { target: { value: 'from:zed' } });
      expect(screen.queryByTestId('search-modifier-option')).toBeNull();
      expect(screen.getByTestId('searchbar-show-results')).toBeInTheDocument();
      expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(true);
    });
  });

  describe('⌘K / Ctrl+K', () => {
    it('opens on Ctrl+K on non-Apple platforms (the ambient jsdom default)', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      expect(input).not.toHaveFocus();
      act(() => {
        fireEvent.keyDown(document, { key: 'K', ctrlKey: true });
      });
      expect(input).toHaveFocus();
    });

    it('ignores Meta+K on non-Apple platforms', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      act(() => {
        fireEvent.keyDown(document, { key: 'k', metaKey: true });
      });
      expect(input).not.toHaveFocus();
    });

    it('opens on Meta+K on Apple platforms and ignores bare Ctrl+K there (kill-line must survive)', () => {
      const restore = stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
      try {
        renderBar();
        const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
        // Ctrl+K is macOS kill-to-end-of-line (and a CodeMirror binding) —
        // the old handler hijacked it mid-edit.
        act(() => {
          fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
        });
        expect(input).not.toHaveFocus();
        act(() => {
          fireEvent.keyDown(document, { key: 'k', metaKey: true });
        });
        expect(input).toHaveFocus();
      } finally {
        restore();
      }
    });

    it('ignores Shift/Alt chords, key-repeat, and both-modifier combos', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      act(() => {
        fireEvent.keyDown(document, { key: 'K', ctrlKey: true, shiftKey: true });
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true, altKey: true });
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true, repeat: true });
        fireEvent.keyDown(document, { key: 'k', ctrlKey: true, metaKey: true });
      });
      expect(input).not.toHaveFocus();
    });

    it('ignores a modifier chord that is not K', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      act(() => {
        fireEvent.keyDown(document, { key: 'j', ctrlKey: true });
      });
      expect(input).not.toHaveFocus();
    });

    it('ignores a plain K with no modifier', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      act(() => {
        fireEvent.keyDown(document, { key: 'k' });
      });
      expect(input).not.toHaveFocus();
    });
  });

  // The field is an ARIA combobox: it says whether its list is open, which
  // element the list is, and which option the keyboard is on — focus stays
  // in the field, so the active option is announced through it.
  it('exposes combobox semantics, following the keyboard highlight', () => {
    useSearchChannelsMock.mockReturnValue({
      data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
      isLoading: false,
    });
    useSearchUsersMock.mockReturnValue({
      data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice', email: 'alice@x.io' } }] },
      isLoading: false,
    });
    renderBar();
    const input = screen.getByRole('combobox', { name: 'Search' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    fireEvent.change(input, { target: { value: 'al' } });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.dataset.testid)).toEqual([
      'searchbar-channel-ch-1',
      'searchbar-user-u-1',
      'searchbar-show-results',
    ]);
    // Options are reached through the field, not with Tab.
    for (const option of options) expect(option).toHaveAttribute('tabindex', '-1');
    expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByTestId('searchbar-show-results').id);
    expect(screen.getByRole('option', { selected: true })).toBe(screen.getByTestId('searchbar-show-results'));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByTestId('searchbar-channel-ch-1').id);
    expect(screen.getByRole('option', { selected: true })).toBe(screen.getByTestId('searchbar-channel-ch-1'));
    expect(within(listbox).getByRole('group', { name: 'Channels' })).toContainElement(screen.getByTestId('searchbar-channel-ch-1'));

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-controls');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('keeps the failure notice out of the list of options', () => {
    useSearchUsersMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('internal server error'),
      refetch: vi.fn(),
    } as never);
    renderBar();
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'hello' } });
    expect(screen.getByTestId('searchbar-failed')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).not.toContainElement(screen.getByTestId('searchbar-failed'));
    expect(screen.getByTestId('searchbar-dropdown')).toContainElement(screen.getByTestId('searchbar-failed'));
  });

  describe('unified sections', () => {
    it('renders Channels and People sections for a query with results', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
        isLoading: false,
      });
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice', email: 'alice@x.io' } }] },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'al' } });
      expect(screen.getByText('Channels')).toBeInTheDocument();
      expect(screen.getByText('People')).toBeInTheDocument();
      expect(screen.getByTestId('searchbar-channel-ch-1')).toBeInTheDocument();
      expect(screen.getByTestId('searchbar-user-u-1')).toBeInTheDocument();
      expect(screen.getByText('alice@x.io')).toBeInTheDocument();

      // Hovering a row moves the highlight to it.
      fireEvent.mouseEnter(screen.getByTestId('searchbar-user-u-1'));
      expect(screen.getByTestId('searchbar-user-u-1').getAttribute('aria-selected')).toBe('true');
      fireEvent.mouseEnter(screen.getByTestId('searchbar-channel-ch-1'));
      expect(screen.getByTestId('searchbar-channel-ch-1').getAttribute('aria-selected')).toBe('true');
    });

    it('renders the people row with a batch-resolved avatar (fresh presigned URL, not from the index)', () => {
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice', email: 'alice@x.io' } }] },
        isLoading: false,
      });
      // The search index has no avatar URL; useUsersBatch supplies the fresh one,
      // exercising the AvatarImage branch. Base UI's AvatarImage only paints the
      // <img> once it loads (not in jsdom), so the real <img src> assertion lives
      // in the browser test; here we just cover the avatar-provided render path.
      useUsersBatchMock.mockReturnValue({
        map: new Map([['u-1', { avatarURL: 'https://cdn.example/alice.png' }]]),
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'al' } });
      expect(screen.getByTestId('searchbar-user-u-1')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('shows the presence dot (online) and the custom-status emoji on a people row', () => {
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice', email: 'alice@x.io' } }] },
        isLoading: false,
      });
      useUsersBatchMock.mockReturnValue({
        map: new Map([
          ['u-1', { avatarURL: 'https://cdn.example/alice.png', userStatus: { emoji: '🌴', text: 'On vacation', clearAt: null } }],
        ]),
        isLoading: false,
      });
      usePresenceStore.getState().setUserOnline('u-1', true);
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'al' } });
      const row = screen.getByTestId('searchbar-user-u-1');
      // Presence dot rides the avatar (online → solid).
      expect(row.querySelector('[data-presence="online"]')).not.toBeNull();
      // Custom-status emoji is aria-labelled by the status text.
      expect(screen.getByLabelText(/On vacation/)).toBeInTheDocument();
    });

    it('a people row follows its own user, and the bar does not re-render for anyone else', () => {
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice' } }] },
        isLoading: false,
      });
      const commits = { count: 0 };
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <Profiler id="bar" onRender={() => { commits.count++; }}>
              <SearchBar />
            </Profiler>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'al' } });
      const row = screen.getByTestId('searchbar-user-u-1');
      expect(row.querySelector('[data-presence="offline"]')).not.toBeNull();
      const settled = commits.count;

      // Someone not in the results comes online: nothing here renders.
      act(() => usePresenceStore.getState().setUserOnline('u-elsewhere', true));
      expect(commits.count).toBe(settled);

      // The listed person does: their row's dot follows.
      act(() => usePresenceStore.getState().setUserOnline('u-1', true));
      expect(screen.getByTestId('searchbar-user-u-1').querySelector('[data-presence="online"]')).not.toBeNull();
    });

    it('renders a people row with no status icon and an offline dot when the person has no status', () => {
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-2', score: 1, _source: { displayName: 'Bob' } }] },
        isLoading: false,
      });
      // No batch record → no avatar, no userStatus; presence set is empty → offline.
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'bo' } });
      const row = screen.getByTestId('searchbar-user-u-2');
      expect(row.querySelector('[data-presence="offline"]')).not.toBeNull();
      // UserStatusIndicator self-hides (no active status) — no status label present.
      expect(screen.queryByLabelText(/won't clear/)).not.toBeInTheDocument();
    });

    it('navigates to /channel/:slug when a channel row is clicked', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'gen' } });
      fireEvent.click(screen.getByTestId('searchbar-channel-ch-1'));
      expect(lastLocation.pathname).toBe('/channel/general');
    });

    it('falls back to the channel id when the hit has no slug', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-9', score: 1, _source: { name: 'legacy', type: 'private' } }] },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'leg' } });
      fireEvent.click(screen.getByTestId('searchbar-channel-ch-9'));
      expect(lastLocation.pathname).toBe('/channel/ch-9');
    });

    it('shows a "Join" hint on a public channel the user has NOT joined, and none on a joined one', () => {
      // Channel search now surfaces public channels the user isn't in (e.g.
      // ~random); the row hints "Join" on those and stays clean on joined ones.
      useUserChannelsMock.mockReturnValue({ data: [{ channelID: 'ch-joined' }] });
      useSearchChannelsMock.mockReturnValue({
        data: {
          hits: [
            { id: 'ch-joined', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } },
            { id: 'ch-random', score: 1, _source: { name: 'random', slug: 'random', type: 'public' } },
          ],
        },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'ra' } });
      expect(screen.queryByTestId('searchbar-channel-ch-joined-join')).toBeNull();
      expect(screen.getByTestId('searchbar-channel-ch-random-join')).toHaveTextContent('Join');
    });

    it('clicking an unjoined public channel navigates to it (the server auto-joins on open)', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-random', score: 1, _source: { name: 'random', slug: 'random', type: 'public' } }] },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'ran' } });
      fireEvent.click(screen.getByTestId('searchbar-channel-ch-random'));
      expect(lastLocation.pathname).toBe('/channel/random');
    });

    it('opens a DM via useOpenDM and clears the bar on success when a person row is clicked', () => {
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice' } }] },
        isLoading: false,
      });
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'al' } });
      fireEvent.click(screen.getByTestId('searchbar-user-u-1'));
      expect(openDMMock).toHaveBeenCalledWith('u-1', expect.any(Object));
      // The default mock runs onSuccess → the bar resets.
      expect(input.value).toBe('');
      expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
    });

    it('keeps the typed query and open dropdown when the DM-create fails', () => {
      // Failure path: openDM never calls onSuccess (the hook shows a toast).
      openDMMock.mockImplementation(() => {});
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice' } }] },
        isLoading: false,
      });
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'al' } });
      fireEvent.click(screen.getByTestId('searchbar-user-u-1'));
      // The old code reset() BEFORE the mutate: a failed create silently
      // wiped the search box. The query and dropdown must survive failure.
      expect(input.value).toBe('al');
      expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    });

    it('renders a user row with an id fallback and no email when fields are absent', () => {
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-2', score: 1, _source: {} }] },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'zz' } });
      const row = screen.getByTestId('searchbar-user-u-2');
      expect(row).toHaveTextContent('u-2');
    });

    it('shows a loading row while entity results are pending', () => {
      useSearchChannelsMock.mockReturnValue({ data: { hits: [] }, isLoading: true });
      useSearchUsersMock.mockReturnValue({ data: { hits: [] }, isLoading: true });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'ab' } });
      expect(screen.getByTestId('searchbar-loading')).toBeInTheDocument();
    });

    it('gates entity hits below MIN_SEARCH_CHARS: hooks called disabled and stale hits are not rendered', () => {
      // The mock returns hits regardless of `enabled` — exactly like React
      // Query's keepPreviousData serving the previous query's hits after
      // the input shrank. They must neither render nor be activatable.
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
        isLoading: false,
      });
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.change(input, { target: { value: 'g' } });
      expect(useSearchChannelsMock).toHaveBeenLastCalledWith('g', false, 5);
      expect(useSearchUsersMock).toHaveBeenLastCalledWith('g', false, 5);
      expect(screen.queryByText('Channels')).toBeNull();
      expect(screen.queryByTestId('searchbar-channel-ch-1')).toBeNull();
      expect(screen.getByTestId('searchbar-show-results')).toBeInTheDocument();
      // Enter runs the message search for the live query — never a stale hit.
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/search');
      expect(lastLocation.search).toContain('q=g');

      // Above the minimum the hooks are enabled and hits render.
      fireEvent.change(input, { target: { value: 'ge' } });
      expect(useSearchChannelsMock).toHaveBeenLastCalledWith('ge', true, 5);
      expect(screen.getByTestId('searchbar-channel-ch-1')).toBeInTheDocument();
    });

    it('Enter with an emptied input activates nothing even while stale hits linger', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
        isLoading: false,
      });
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'gen' } });
      expect(screen.getByTestId('searchbar-channel-ch-1')).toBeInTheDocument();
      // Clear the input: the dropdown hides, and Enter must be a no-op —
      // the old handler activated the lingering keepPreviousData hit and
      // silently navigated to ~general from an EMPTY search box.
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/');
    });

    it('tolerates undefined query/channel-list data (nullish fallbacks)', () => {
      useSearchChannelsMock.mockReturnValue({ data: undefined, isLoading: false });
      useSearchUsersMock.mockReturnValue({ data: undefined, isLoading: false });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'xy' } });
      // No entity sections, but the message action still renders.
      expect(screen.queryByText('Channels')).toBeNull();
      expect(screen.queryByText('People')).toBeNull();
      expect(screen.getByTestId('searchbar-show-results')).toBeInTheDocument();
    });

    it('falls back to the channel id as its display name when name is absent', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-x', score: 1, _source: { slug: 'ch-x', type: 'public' } }] },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'ch' } });
      expect(screen.getByTestId('searchbar-channel-ch-x')).toHaveTextContent('~ch-x');
    });

    it('defaults the highlight to the message-search action even with entity hits present', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
        isLoading: false,
      });
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.change(input, { target: { value: 'gen' } });
      // Enter without arrowing runs the message search for the LIVE query —
      // never whichever channel hit happened to land at index 0 first (the
      // old index-0 default made Enter's destination fetch-timing-dependent).
      expect(screen.getByTestId('searchbar-show-results').getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/search');
      expect(lastLocation.search).toContain('q=gen');
    });

    it('keyboard nav wraps from the message action to channels → people, and Enter activates the arrowed row', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
        isLoading: false,
      });
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice' } }] },
        isLoading: false,
      });
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.change(input, { target: { value: 'al' } });
      // Default = the message action (last item); Down wraps to the channel.
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(screen.getByTestId('searchbar-channel-ch-1').getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(screen.getByTestId('searchbar-user-u-1').getAttribute('aria-selected')).toBe('true');
      // Up back to the channel, then Enter activates it.
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/channel/general');
    });

    it('typing resets an arrowed-to selection back to the message action', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
        isLoading: false,
      });
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.change(input, { target: { value: 'gen' } });
      fireEvent.keyDown(input, { key: 'ArrowDown' }); // select the channel row
      expect(screen.getByTestId('searchbar-channel-ch-1').getAttribute('aria-selected')).toBe('true');
      // More typing → the selection for the old query must not survive.
      fireEvent.change(input, { target: { value: 'gene' } });
      expect(screen.getByTestId('searchbar-show-results').getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/search');
      expect(lastLocation.search).toContain('q=gene');
    });

    it('an arrowed-to selection survives hits reordering, and a vanished selection falls back to the message action', () => {
      const chGeneral = { id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } };
      const chGenerator = { id: 'ch-2', score: 1, _source: { name: 'generator', slug: 'generator', type: 'public' } };
      useSearchChannelsMock.mockReturnValue({ data: { hits: [chGeneral, chGenerator] }, isLoading: false });
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.change(input, { target: { value: 'gen' } });
      fireEvent.keyDown(input, { key: 'ArrowDown' }); // → ch-1
      fireEvent.keyDown(input, { key: 'ArrowDown' }); // → ch-2
      expect(screen.getByTestId('searchbar-channel-ch-2').getAttribute('aria-selected')).toBe('true');

      // Async refetch reorders the hits: the highlight follows ch-2's
      // identity to its new position instead of sticking to a raw index.
      useSearchChannelsMock.mockReturnValue({ data: { hits: [chGenerator, chGeneral] }, isLoading: false });
      fireEvent.focus(input); // re-render tick
      expect(screen.getByTestId('searchbar-channel-ch-2').getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/channel/generator');

      // Selection vanishing entirely (list shrank) falls back to the
      // message action, exercising the safeHighlight clamp semantics.
      fireEvent.change(input, { target: { value: 'gen' } });
      fireEvent.keyDown(input, { key: 'ArrowDown' }); // → ch-2 (first hit now)
      useSearchChannelsMock.mockReturnValue({ data: { hits: [chGeneral] }, isLoading: false });
      fireEvent.change(input, { target: { value: 'gene' } });
      expect(screen.getByTestId('searchbar-show-results').getAttribute('aria-selected')).toBe('true');
    });

    it('adds an in-scope message action on a channel route and navigates with in+type', () => {
      useChannelBySlugMock.mockReturnValue({ data: { id: 'ch-1', name: 'general', slug: 'general', type: 'public' } });
      renderBar('/channel/general');
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'bug' } });
      const scoped = screen.getByTestId('searchbar-show-in-scope');
      expect(scoped.getAttribute('data-scope-kind')).toBe('channel');
      fireEvent.click(scoped);
      expect(lastLocation.pathname).toBe('/search');
      expect(lastLocation.search).toContain('in=ch-1');
      expect(lastLocation.search).toContain('type=messages');
    });

    it('hovering the in-scope action highlights it and Enter runs the scoped search', () => {
      useChannelBySlugMock.mockReturnValue({ data: { id: 'ch-1', name: 'general', slug: 'general', type: 'public' } });
      renderBar('/channel/general');
      const input = screen.getByTestId('searchbar-input');
      fireEvent.change(input, { target: { value: 'bug' } });
      const scoped = screen.getByTestId('searchbar-show-in-scope');
      fireEvent.mouseEnter(scoped);
      expect(scoped.getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/search');
      expect(lastLocation.search).toContain('in=ch-1');
    });

    it('adds an in-scope DM message action on a conversation route', () => {
      useUserConversationsMock.mockReturnValue({
        data: [{ conversationID: 'cv-1', type: 'dm', displayName: 'Bob' }],
      });
      renderBar('/conversation/cv-1');
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'hey' } });
      const scoped = screen.getByTestId('searchbar-show-in-scope');
      expect(scoped.getAttribute('data-scope-kind')).toBe('dm');
      fireEvent.click(scoped);
      expect(lastLocation.search).toContain('type=dms');
    });

    it('adds an in-scope group message action on a group conversation route', () => {
      useUserConversationsMock.mockReturnValue({
        data: [{ conversationID: 'cv-2', type: 'group', displayName: 'Eng huddle' }],
      });
      renderBar('/conversation/cv-2');
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'plan' } });
      expect(screen.getByTestId('searchbar-show-in-scope').getAttribute('data-scope-kind')).toBe('group');
    });
  });

  // People and channels that didn't come back say so, and can be asked for
  // again; the message search below still works.
  it('says when people and channels could not be searched, and tries again', () => {
    const refetchUsers = vi.fn();
    const refetchChannels = vi.fn();
    useSearchUsersMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new DOMException('signal timed out', 'TimeoutError'),
      refetch: refetchUsers,
    } as never);
    useSearchChannelsMock.mockReturnValue({ data: { hits: [] }, isLoading: false, isError: false, refetch: refetchChannels } as never);
    renderBar();
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'hello' } });
    expect(screen.getByTestId('searchbar-failed')).toHaveTextContent('Search timed out');
    expect(screen.getByRole('group', { name: 'Messages' })).toHaveTextContent('hello');
    // Pressing it leaves the focus in the field.
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Try again' }))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchUsers).toHaveBeenCalledTimes(1);
    expect(refetchChannels).not.toHaveBeenCalled();
  });

  it('retries the channel search when that is the one that failed', () => {
    const refetchChannels = vi.fn();
    useSearchChannelsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('internal server error'),
      refetch: refetchChannels,
    } as never);
    renderBar();
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'hello' } });
    expect(screen.getByTestId('searchbar-failed')).toHaveTextContent('Search failed');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchChannels).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a failure once the text is too short to search', () => {
    useSearchUsersMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('x'), refetch: vi.fn() } as never);
    renderBar();
    fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'h' } });
    expect(screen.queryByTestId('searchbar-failed')).toBeNull();
  });

  // Several people typed: the group messages they're all in.
  describe('group messages', () => {
    const group = (id: string, displayName: string, participantIDs: string[]) => ({
      userID: 'me', conversationID: id, type: 'group', displayName, participantIDs, activated: true, joinedAt: '2026-01-01T00:00:00Z',
    });

    it('finds the group with everyone named, and opens it', () => {
      useUserConversationsMock.mockReturnValue({
        data: [
          group('g-ab', 'Alice Example, Bob Builder', ['me', 'alice', 'bob']),
          group('g-ac', 'Alice Example, Carol', ['me', 'alice', 'carol']),
          { ...group('dm-a', 'Alice Example', ['me', 'alice']), type: 'dm' },
        ],
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'ali bob' } });
      const section = screen.getByRole('group', { name: 'Group messages' });
      expect(section).toHaveTextContent('Alice Example, Bob Builder');
      expect(section).not.toHaveTextContent('Carol');
      fireEvent.click(screen.getByTestId('searchbar-group-g-ab'));
      expect(lastLocation.pathname).toBe('/conversation/g-ab');
      expect((screen.getByTestId('searchbar-input') as HTMLInputElement).value).toBe('');
    });

    it('opens the highlighted group with Enter', () => {
      useUserConversationsMock.mockReturnValue({ data: [group('g-ab', 'Alice Example, Bob Builder', ['me', 'alice', 'bob'])] });
      renderBar();
      const input = screen.getByTestId('searchbar-input');
      fireEvent.change(input, { target: { value: 'alice bob' } });
      fireEvent.mouseEnter(screen.getByTestId('searchbar-group-g-ab'));
      expect(screen.getByTestId('searchbar-group-g-ab')).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/conversation/g-ab');
    });

    it('shows no groups for a single letter', () => {
      useUserConversationsMock.mockReturnValue({ data: [group('g-ab', 'Alice Example, Bob Builder', ['me', 'alice', 'bob'])] });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'a' } });
      expect(screen.queryByRole('group', { name: 'Group messages' })).toBeNull();
    });
  });
});
