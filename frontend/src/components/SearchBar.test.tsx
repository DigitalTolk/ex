import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SearchBar } from './SearchBar';

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
  useSearchUsers: (...args: unknown[]) => useSearchUsersMock(...(args as [])),
  useSearchChannels: (...args: unknown[]) => useSearchChannelsMock(...(args as [])),
}));
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: (...args: unknown[]) => useUsersBatchMock(...(args as [])),
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

function renderBar(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SearchBar />
      <LocationProbe />
    </MemoryRouter>,
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

  it('ignores ArrowUp/ArrowDown when there are no items', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.focus(input); // open, but empty query → no items
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
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
});
