import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchBar } from './SearchBar';

const useChannelBySlugMock = vi.hoisted(() => vi.fn(() => ({ data: undefined as unknown })));
const useUserChannelsMock = vi.hoisted(() => vi.fn(() => ({ data: [] as { channelID: string }[] })));
const useUserConversationsMock = vi.hoisted(() => vi.fn(() => ({ data: undefined as unknown })));
// openDM defaults to its success path (runs the caller's onSuccess, which
// resets the bar); the navigation itself belongs to the real hook and is
// covered by its own tests.
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

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue(null),
}));
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
// Presence powers the people-row online/offline dot. Mock it (like the jsdom
// suite) so the real PresenceContext — which pulls AuthContext + auth-api into
// the graph past the stubbed `@/lib/api` — stays out of this render.
const onlineSet = vi.hoisted(() => new Set<string>());
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: onlineSet }),
}));
// UserStatusIndicator resolves custom emojis via React Query; stub the map.
vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));
vi.mock('@/hooks/useDebouncedValue', () => ({
  useDebouncedValue: (v: unknown) => v,
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc" data-path={loc.pathname} data-search={loc.search} />;
}

function renderWithLocation(initialPath = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <div data-app-chrome="true">
          <SearchBar />
        </div>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderSearchBar(initialPath = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <div data-app-chrome="true" style={{ background: 'var(--color-sidebar)', padding: 12 }}>
          <SearchBar />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function colorToRGBA(color: string): [number, number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const { data } = ctx.getImageData(0, 0, 1, 1);
  return [data[0], data[1], data[2], data[3] / 255];
}

function effectiveBackground(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    const [, , , a] = colorToRGBA(bg);
    if (a > 0) return bg;
    node = node.parentElement;
  }
  return 'rgb(255, 255, 255)';
}

function relativeLuminance(color: string) {
  const [r, g, b] = colorToRGBA(color).slice(0, 3).map((value) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

beforeEach(() => {
  useChannelBySlugMock.mockReturnValue({ data: undefined });
  useUserChannelsMock.mockReturnValue({ data: [] });
  useUserConversationsMock.mockReturnValue({ data: undefined });
  useSearchUsersMock.mockReturnValue({ data: { hits: [] }, isLoading: false });
  useSearchChannelsMock.mockReturnValue({ data: { hits: [] }, isLoading: false });
  useUsersBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
  openDMMock.mockClear();
  openDMMock.mockImplementation((_userID, opts) => opts?.onSuccess?.());
});

// The shortcut is the PLATFORM chord: ⌘K where the (real) browser UA is
// Apple, Ctrl+K elsewhere — matching what the visible hint advertises.
// Browser projects run under real UAs (mac locally, Linux in CI, iPhone
// in the webkit-iphone project), so derive the expectation per run.
const APPLE_UA = /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
const chordInit: KeyboardEventInit = APPLE_UA ? { metaKey: true } : { ctrlKey: true };
const wrongModifierInit: KeyboardEventInit = APPLE_UA ? { ctrlKey: true } : { metaKey: true };

describe('SearchBar browser behavior', () => {
  it('keeps search input text readable inside light app chrome', async () => {
    document.documentElement.classList.remove('dark');
    const screen = await renderSearchBar();

    const input = screen.getByTestId('searchbar-input').element();
    const shell = input.parentElement as HTMLElement;
    await expect.element(input).toBeVisible();

    const inputColor = getComputedStyle(input).color;
    const shellColor = effectiveBackground(shell);
    expect(contrastRatio(inputColor, shellColor)).toBeGreaterThanOrEqual(4.5);
  });

  it('opens the dropdown with the "Search messages for" row when typing on a generic route', async () => {
    const screen = await renderSearchBar('/');
    await screen.getByTestId('searchbar-input').fill('foo');
    await expect.element(screen.getByTestId('searchbar-dropdown')).toBeVisible();
    await expect.element(screen.getByTestId('searchbar-show-results')).toBeVisible();
    expect(document.querySelector('[data-testid="searchbar-show-in-scope"]')).toBeNull();

    // Hovering the all-messages row moves the shared keyboard/mouse highlight
    // onto it (the un-scoped arm of the hover key).
    await screen.getByTestId('searchbar-show-results').hover();
    await expect.element(screen.getByTestId('searchbar-show-results')).toHaveAttribute('aria-selected', 'true');
  });

  it('adds a channel-scoped message row when the route is /channel/:slug', async () => {
    useChannelBySlugMock.mockReturnValue({
      data: { id: 'ch-1', name: 'general', slug: 'general', type: 'public' },
    });
    const screen = await renderSearchBar('/channel/general');
    await screen.getByTestId('searchbar-input').fill('bug');
    const scopeRow = await screen.getByTestId('searchbar-show-in-scope');
    await expect.element(scopeRow).toBeVisible();
    const el = scopeRow.element() as HTMLElement;
    expect(el.dataset.scopeKind).toBe('channel');
    expect(el.textContent).toContain('~general');
  });

  it('adds a DM-scoped message row for a 1:1 conversation route', async () => {
    useUserConversationsMock.mockReturnValue({
      data: [{ conversationID: 'cv-1', type: 'dm', displayName: 'Bob' }],
    });
    const screen = await renderSearchBar('/conversation/cv-1');
    await screen.getByTestId('searchbar-input').fill('hey');
    const scopeRow = await screen.getByTestId('searchbar-show-in-scope');
    await expect.element(scopeRow).toBeVisible();
    expect((scopeRow.element() as HTMLElement).dataset.scopeKind).toBe('dm');
  });

  it('adds a group-scoped message row for a group conversation route', async () => {
    useUserConversationsMock.mockReturnValue({
      data: [{ conversationID: 'cv-2', type: 'group', displayName: 'Eng huddle' }],
    });
    const screen = await renderSearchBar('/conversation/cv-2');
    await screen.getByTestId('searchbar-input').fill('roadmap');
    const scopeRow = await screen.getByTestId('searchbar-show-in-scope');
    await expect.element(scopeRow).toBeVisible();
    expect((scopeRow.element() as HTMLElement).dataset.scopeKind).toBe('group');
  });

  it('clear button empties the input', async () => {
    const screen = await renderSearchBar();
    await screen.getByTestId('searchbar-input').fill('foo');
    const clear = await screen.getByLabelText('Clear search');
    await clear.click();
    const input = screen.getByTestId('searchbar-input').element() as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('Enter submits and clears the input', async () => {
    const screen = await renderSearchBar();
    const input = screen.getByTestId('searchbar-input');
    await input.fill('foo');
    await input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect((input.element() as HTMLInputElement).value).toBe('');
    });
  });

  it('submitting an in-scope channel row navigates with in + type params', async () => {
    useChannelBySlugMock.mockReturnValue({ data: { id: 'ch-1', name: 'general', slug: 'general', type: 'public' } });
    const screen = await renderWithLocation('/channel/general');
    await screen.getByTestId('searchbar-input').fill('bug');
    await screen.getByTestId('searchbar-show-in-scope').click();
    await vi.waitFor(() => {
      const loc = screen.getByTestId('loc').element() as HTMLElement;
      expect(loc.dataset.search).toContain('in=ch-1');
      expect(loc.dataset.search).toContain('type=messages');
    });
  });

  it('submitting an in-scope DM row navigates with type=dms', async () => {
    useUserConversationsMock.mockReturnValue({ data: [{ conversationID: 'cv-1', type: 'dm', displayName: 'Bob' }] });
    const screen = await renderWithLocation('/conversation/cv-1');
    await screen.getByTestId('searchbar-input').fill('hey');
    await screen.getByTestId('searchbar-show-in-scope').click();
    await vi.waitFor(() => {
      expect((screen.getByTestId('loc').element() as HTMLElement).dataset.search).toContain('type=dms');
    });
  });

  it('ArrowDown / ArrowUp move the highlight and Enter submits the highlighted row', async () => {
    useChannelBySlugMock.mockReturnValue({ data: { id: 'ch-1', name: 'general', slug: 'general', type: 'public' } });
    const screen = await renderWithLocation('/channel/general');
    const input = screen.getByTestId('searchbar-input');
    await input.fill('bug');
    await expect.element(screen.getByTestId('searchbar-dropdown')).toBeVisible();
    const el = input.element();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect((screen.getByTestId('loc').element() as HTMLElement).dataset.search).toContain('q=bug');
    });
  });

  it('ArrowDown with no items (empty query) is a no-op', async () => {
    const screen = await renderWithLocation();
    const input = screen.getByTestId('searchbar-input');
    await input.element().dispatchEvent(new Event('focus', { bubbles: true }));
    input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    // A neutral key falls through the whole else-if chain without effect.
    input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect((screen.getByTestId('loc').element() as HTMLElement).dataset.path).toBe('/');
  });

  it('Escape closes the dropdown', async () => {
    const screen = await renderWithLocation();
    const input = screen.getByTestId('searchbar-input');
    await input.fill('foo');
    await expect.element(screen.getByTestId('searchbar-dropdown')).toBeVisible();
    input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="searchbar-dropdown"]')).toBeNull();
    });
  });

  it('a mousedown outside the search container closes the dropdown', async () => {
    const screen = await renderWithLocation();
    await screen.getByTestId('searchbar-input').fill('foo');
    await expect.element(screen.getByTestId('searchbar-dropdown')).toBeVisible();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="searchbar-dropdown"]')).toBeNull();
    });
  });

  it('Enter with a whitespace-only query does not submit', async () => {
    const screen = await renderWithLocation();
    const input = screen.getByTestId('searchbar-input');
    await input.fill('   ');
    input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect((screen.getByTestId('loc').element() as HTMLElement).dataset.path).toBe('/');
  });

  it('the platform search chord focuses and opens the search from anywhere', async () => {
    const screen = await renderWithLocation();
    const input = screen.getByTestId('searchbar-input').element() as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ...chordInit, bubbles: true }));
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it('honours Ctrl+K on a non-Apple platform (UA-driven chord)', async () => {
    // The projects all run on Apple UAs here — force the Windows arm so both
    // sides of the platform chord stay pinned.
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    try {
      const screen = await renderWithLocation();
      const input = screen.getByTestId('searchbar-input').element() as HTMLInputElement;
      // The Apple chord (meta) must NOT fire on Windows…
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      expect(document.activeElement).not.toBe(input);
      // …the Windows chord (ctrl) must.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
    } finally {
      delete (navigator as { userAgent?: unknown }).userAgent;
    }
  });

  it('the platform chord wins even while the user is typing in an editable field', async () => {
    // The real-world "from anywhere" case: focus is inside a text-editing
    // surface (the composer). The document-level chord must still reach
    // the search box — and the WRONG modifier must leave the editor alone
    // (bare Ctrl+K on macOS is kill-to-end-of-line; hijacking it mid-edit
    // was a real bug).
    const screen = await renderWithLocation();
    const editor = document.createElement('textarea');
    editor.setAttribute('data-testid', 'editor');
    document.body.appendChild(editor);
    try {
      editor.focus();
      editor.value = 'drafting a message';
      expect(document.activeElement).toBe(editor);

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ...wrongModifierInit, bubbles: true }),
      );
      expect(document.activeElement).toBe(editor);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ...chordInit, bubbles: true }));
      const input = screen.getByTestId('searchbar-input').element() as HTMLInputElement;
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
      expect(editor.value).toBe('drafting a message');
    } finally {
      editor.remove();
    }
  });

  it('the wrong modifier, Shift/Alt chords, key-repeat, a non-K chord, and a plain key do not focus', async () => {
    const screen = await renderWithLocation();
    const input = screen.getByTestId('searchbar-input').element() as HTMLInputElement;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ...wrongModifierInit, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ...chordInit, shiftKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ...chordInit, altKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ...chordInit, repeat: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ...chordInit, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    expect(document.activeElement).not.toBe(input);
  });

  it('renders Channels + People sections, a Join hint on unjoined channels, and opens a channel on click', async () => {
    // ch-1 is joined; ch-2 is a channel the user hasn't joined → "Join" hint.
    useUserChannelsMock.mockReturnValue({ data: [{ channelID: 'ch-1' }] });
    useSearchChannelsMock.mockReturnValue({
      data: {
        hits: [
          { id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } },
          // Slug-less private channel: click must fall back to the id.
          { id: 'ch-2', score: 1, _source: { name: 'secret', type: 'private' } },
        ],
      },
      isLoading: false,
    });
    useSearchUsersMock.mockReturnValue({
      data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice', email: 'alice@x.io' } }] },
      isLoading: false,
    });
    const screen = await renderWithLocation();
    await screen.getByTestId('searchbar-input').fill('se');
    await expect.element(screen.getByText('Channels')).toBeVisible();
    await expect.element(screen.getByText('People')).toBeVisible();
    await expect.element(screen.getByTestId('searchbar-channel-ch-2-join')).toBeVisible();
    expect(document.querySelector('[data-testid="searchbar-channel-ch-1-join"]')).toBeNull();
    await screen.getByTestId('searchbar-channel-ch-2').click();
    await vi.waitFor(() => {
      expect((screen.getByTestId('loc').element() as HTMLElement).dataset.path).toBe('/channel/ch-2');
    });
  });

  it('opens a DM via useOpenDM and resets the bar on success when a person row is clicked', async () => {
    useSearchUsersMock.mockReturnValue({
      data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice' } }] },
      isLoading: false,
    });
    const screen = await renderWithLocation();
    const input = screen.getByTestId('searchbar-input');
    await input.fill('al');
    await screen.getByTestId('searchbar-user-u-1').click();
    expect(openDMMock).toHaveBeenCalledWith('u-1', expect.any(Object));
    // Default openDM mock runs onSuccess → the bar clears and closes.
    await vi.waitFor(() => {
      expect((input.element() as HTMLInputElement).value).toBe('');
    });
  });

  it('a failed DM-create keeps the query and dropdown so the user can retry', async () => {
    openDMMock.mockImplementation(() => {}); // failure: no onSuccess, hook shows a toast
    useSearchUsersMock.mockReturnValue({
      data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice' } }] },
      isLoading: false,
    });
    const screen = await renderWithLocation();
    const input = screen.getByTestId('searchbar-input');
    await input.fill('al');
    await screen.getByTestId('searchbar-user-u-1').click();
    expect((input.element() as HTMLInputElement).value).toBe('al');
    await expect.element(screen.getByTestId('searchbar-dropdown')).toBeVisible();
  });

  it('paints a fresh presigned avatar image on a person row (from the batch endpoint)', async () => {
    // A real (loadable) 1x1 PNG data URI — Base UI's AvatarImage only paints the
    // <img> once it actually loads, so a bogus URL would never render.
    const avatar =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    useSearchUsersMock.mockReturnValue({
      data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice', email: 'alice@x.io' } }] },
      isLoading: false,
    });
    // The search index carries no avatar; useUsersBatch resolves the fresh one.
    useUsersBatchMock.mockReturnValue({
      map: new Map([['u-1', { avatarURL: avatar }]]),
      isLoading: false,
    });
    const screen = await renderWithLocation();
    await screen.getByTestId('searchbar-input').fill('al');
    await vi.waitFor(() => {
      const img = (screen.getByTestId('searchbar-user-u-1').element() as HTMLElement).querySelector('img');
      expect(img?.getAttribute('src')).toBe(avatar);
    });
  });

  it('keyboard nav walks channels → people → message action', async () => {
    useSearchChannelsMock.mockReturnValue({
      data: { hits: [{ id: 'ch-1', score: 1, _source: { name: 'general', slug: 'general', type: 'public' } }] },
      isLoading: false,
    });
    useSearchUsersMock.mockReturnValue({
      data: { hits: [{ id: 'u-1', score: 1, _source: { displayName: 'Alice' } }] },
      isLoading: false,
    });
    const screen = await renderWithLocation();
    const input = screen.getByTestId('searchbar-input');
    await input.fill('al');
    await expect.element(screen.getByTestId('searchbar-channel-ch-1')).toBeVisible();
    const el = input.element();
    // Default highlight is the message-search action; hover a person to
    // move it, then arrow down wraps onward to the message action.
    await screen.getByTestId('searchbar-user-u-1').hover();
    expect((screen.getByTestId('searchbar-user-u-1').element() as HTMLElement).getAttribute('aria-selected')).toBe('true');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await vi.waitFor(() => {
      expect((screen.getByTestId('searchbar-show-results').element() as HTMLElement).getAttribute('aria-selected')).toBe('true');
    });
  });

  it('renders rows with id/empty fallbacks when hit fields are absent', async () => {
    useSearchChannelsMock.mockReturnValue({
      data: { hits: [{ id: 'ch-x', score: 1, _source: { type: 'public' } }] },
      isLoading: false,
    });
    useSearchUsersMock.mockReturnValue({
      data: { hits: [{ id: 'u-x', score: 1, _source: {} }] },
      isLoading: false,
    });
    const screen = await renderWithLocation();
    await screen.getByTestId('searchbar-input').fill('xy');
    await expect.element(screen.getByTestId('searchbar-channel-ch-x')).toBeVisible();
    expect((screen.getByTestId('searchbar-channel-ch-x').element() as HTMLElement).textContent).toContain('~ch-x');
    expect((screen.getByTestId('searchbar-user-u-x').element() as HTMLElement).textContent).toContain('u-x');
  });

  it('tolerates undefined query data (nullish hit fallbacks)', async () => {
    useSearchChannelsMock.mockReturnValue({ data: undefined, isLoading: false });
    useSearchUsersMock.mockReturnValue({ data: undefined, isLoading: false });
    const screen = await renderWithLocation();
    await screen.getByTestId('searchbar-input').fill('zz');
    await expect.element(screen.getByTestId('searchbar-show-results')).toBeVisible();
    expect(document.querySelector('[data-testid="searchbar-loading"]')).toBeNull();
  });

  it('shows a loading row while entity results are pending', async () => {
    useSearchChannelsMock.mockReturnValue({ data: { hits: [] }, isLoading: true });
    useSearchUsersMock.mockReturnValue({ data: { hits: [] }, isLoading: true });
    const screen = await renderWithLocation();
    await screen.getByTestId('searchbar-input').fill('ab');
    await expect.element(screen.getByTestId('searchbar-loading')).toBeVisible();
  });
});
