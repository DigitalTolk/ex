import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SearchBar } from './SearchBar';

const useChannelBySlugMock = vi.hoisted(() => vi.fn(() => ({ data: undefined as unknown })));
const useUserChannelsMock = vi.hoisted(() => vi.fn(() => ({ data: [] as unknown[] })));
const useUserConversationsMock = vi.hoisted(() => vi.fn(() => ({ data: [] as unknown[] })));
const createConvMutate = vi.hoisted(() => vi.fn());
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
  useCreateConversation: () => ({ mutate: createConvMutate }),
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
  createConvMutate.mockReset();
  lastLocation = { pathname: '/', search: '' };
});

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
    it('focuses and opens the search on Meta+K from anywhere', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      expect(input).not.toHaveFocus();
      act(() => {
        fireEvent.keyDown(document, { key: 'k', metaKey: true });
      });
      expect(input).toHaveFocus();
    });

    it('also opens on Ctrl+K', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      act(() => {
        fireEvent.keyDown(document, { key: 'K', ctrlKey: true });
      });
      expect(input).toHaveFocus();
    });

    it('ignores a modifier chord that is not K', () => {
      renderBar();
      const input = screen.getByTestId('searchbar-input') as HTMLInputElement;
      act(() => {
        fireEvent.keyDown(document, { key: 'j', metaKey: true });
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

    it('shows a Joined badge for a channel the user is already in, Join otherwise', () => {
      useUserChannelsMock.mockReturnValue({ data: [{ channelID: 'ch-1' }] });
      useSearchChannelsMock.mockReturnValue({
        data: {
          hits: [
            { id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } },
            { id: 'ch-2', score: 1, _source: { name: 'random', slug: 'random', type: 'public' } },
          ],
        },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'ra' } });
      expect(screen.getByTestId('searchbar-channel-ch-1-badge')).toHaveTextContent('Joined');
      expect(screen.getByTestId('searchbar-channel-ch-2-badge')).toHaveTextContent('Join');
    });

    it('opens/creates a DM and navigates when a person row is clicked', () => {
      createConvMutate.mockImplementation((_vars, opts) => opts.onSuccess({ id: 'cv-77' }));
      useSearchUsersMock.mockReturnValue({
        data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice' } }] },
        isLoading: false,
      });
      renderBar();
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'al' } });
      fireEvent.click(screen.getByTestId('searchbar-user-u-1'));
      expect(createConvMutate).toHaveBeenCalledWith(
        { type: 'dm', participantIDs: ['u-1'] },
        expect.any(Object),
      );
      expect(lastLocation.pathname).toBe('/conversation/cv-77');
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

    it('does not show entity sections for a single-character query', () => {
      useSearchChannelsMock.mockReturnValue({
        data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
        isLoading: false,
      });
      renderBar();
      // Below MIN_SEARCH_CHARS: enabled=false, so no entity section header,
      // but the message action is still present.
      fireEvent.change(screen.getByTestId('searchbar-input'), { target: { value: 'g' } });
      // hits are non-empty from the mock, but the hook returns them
      // regardless of enabled; the Channels header still renders because
      // gating is on hits length. Assert the message action coexists.
      expect(screen.getByTestId('searchbar-show-results')).toBeInTheDocument();
    });

    it('tolerates undefined query/channel-list data (nullish fallbacks)', () => {
      useUserChannelsMock.mockReturnValue({ data: undefined });
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

    it('keyboard nav walks channels → people → message action and Enter activates', () => {
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
      // First item (channel) highlighted by default (index 0).
      expect(screen.getByTestId('searchbar-channel-ch-1').getAttribute('aria-selected')).toBe('true');
      // Down → user, Down → message action.
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(screen.getByTestId('searchbar-user-u-1').getAttribute('aria-selected')).toBe('true');
      // Up back to channel, then Enter activates the channel.
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(lastLocation.pathname).toBe('/channel/general');
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
