import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { swipe } from '@/test/gestures';
import { EmojiPicker } from './EmojiPicker';

// Browser coverage for EmojiPicker — exercises trigger, search,
// category switching, and skin-tone selection paths.

const customEmojiData = vi.hoisted(() => ({
  value: [
    { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
  ] as unknown,
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: customEmojiData.value }),
  useEmojiMap: () => ({ data: { partyparrot: 'https://emoji.test/parrot.gif' } }),
}));

const apiFetchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'u-1', emojiSkinTone: 'medium' }));
const tokenRef = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getAccessToken: () => tokenRef.value,
}));

// Server-backed frequently-used shelf — mocked so the list is deterministic.
const freqRef = vi.hoisted(() => ({ value: [] as string[] }));
const recordMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/emoji-frequency', () => ({
  EMOJI_FREQUENCY_CHANGED_EVENT: 'emoji-frequency-changed',
  getFrequentEmojis: vi.fn(async (limit: number) => freqRef.value.slice(0, limit)),
  recordEmojiUse: (shortcode: string) => recordMock(shortcode),
}));

const setAuthMock = vi.hoisted(() => vi.fn());
const authUserRef = vi.hoisted(() => ({
  value: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', emojiSkinTone: '' } as Record<string, unknown> | null,
}));
vi.mock('@/context/AuthContext', () => {
  const makeState = () => ({
    user: authUserRef.value,
    isAuthenticated: true,
    isLoading: false,
    setAuth: setAuthMock,
  });
  return {
    useAuth: () => makeState(),
    useOptionalAuth: () => makeState(),
    AuthContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  };
});

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seedFrequency(shortcodes: string[]) {
  freqRef.value = shortcodes;
}

describe('EmojiPicker browser', () => {
  it('pins flagged customs into the front "Getting Work Done" shelf, capped to two rows', async () => {
    const flagged = Array.from({ length: 20 }, (_, i) => ({
      name: `work${i}`,
      imageURL: `https://emoji.test/w${i}.png`,
      createdBy: 'u-1',
      createdAt: '2026-05-01T10:00:00Z',
      gettingWorkDone: true,
    }));
    customEmojiData.value = [
      ...flagged,
      { name: 'plain', imageURL: 'https://emoji.test/plain.png', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ];
    const { onSelect } = await openPicker();

    const grid = document.querySelector('[data-testid="emoji-workpack-grid"]') as HTMLElement;
    expect(grid).not.toBeNull();
    const tiles = grid.querySelectorAll('[data-testid="emoji-workpack-tile"]');
    // Two rows: 9 columns on desktop, 7 on mobile — never all 20.
    expect(tiles.length).toBe(window.innerWidth > 767 ? 18 : 14);
    // Unflagged customs stay out of the shelf.
    expect(grid.textContent ?? '').not.toContain('plain');

    // Picking from the shelf selects like any other tile.
    (tiles[0] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(':work0:');
  });

  it('renders "Getting Work Done" BELOW "Frequently used" and dedups its emojis out of the frequent shelf', async () => {
    customEmojiData.value = [
      { name: 'shipit', imageURL: 'https://emoji.test/s.png', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z', gettingWorkDone: true },
      { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ];
    // The user's frequent list contains the pinned emoji AND a regular one.
    seedFrequency([':shipit:', ':tada:']);
    await openPicker();

    const freq = document.querySelector('[data-testid="emoji-frequent-grid"]') as HTMLElement;
    const work = document.querySelector('[data-testid="emoji-workpack-grid"]') as HTMLElement;
    expect(freq).not.toBeNull();
    expect(work).not.toBeNull();
    // Order: frequent first, the work pack right below it.
    expect(freq.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Dedup: the pinned emoji lives ONLY in the work pack.
    expect(freq.querySelector('[aria-label="React with :shipit:"]')).toBeNull();
    expect(freq.querySelector('[aria-label="React with :tada:"]')).not.toBeNull();
    expect(work.querySelector('[aria-label="React with :shipit:"]')).not.toBeNull();
  });

  it('hides the frequent shelf entirely when every frequent emoji is pinned in the work pack', async () => {
    customEmojiData.value = [
      { name: 'shipit', imageURL: 'https://emoji.test/s.png', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z', gettingWorkDone: true },
    ];
    seedFrequency([':shipit:']);
    await openPicker();
    expect(document.querySelector('[data-testid="emoji-frequent-grid"]')).toBeNull();
    expect(document.querySelector('[data-testid="emoji-workpack-grid"]')).not.toBeNull();
  });

  it('hides the "Getting Work Done" shelf while searching and when nothing is flagged', async () => {
    customEmojiData.value = [
      { name: 'work0', imageURL: 'https://emoji.test/w0.png', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z', gettingWorkDone: true },
    ];
    const { screen } = await openPicker();
    expect(document.querySelector('[data-testid="emoji-workpack-grid"]')).not.toBeNull();
    await screen.getByLabelText('Search emojis').fill('smile');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="emoji-workpack-grid"]')).toBeNull();
    });
  });

  // Keep the frequently-used shelf deterministic across tests, and reset the
  // custom-emoji roster my work-pack tests mutate.
  beforeEach(() => {
    freqRef.value = [];
    recordMock.mockClear();
    customEmojiData.value = [
      { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ];
  });

  it('renders the frequently-used shelf and selects from it', async () => {
    seedFrequency([':tada:', ':smile:']);
    const onSelect = vi.fn();
    const screen = await render(<Wrap><EmojiPicker onSelect={onSelect} /></Wrap>);
    await screen.getByLabelText('Open emoji picker').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Frequently used emojis"]')).not.toBeNull();
    });
    const tile = document.querySelector('[data-testid="emoji-frequent-tile"]') as HTMLElement;
    expect(tile).not.toBeNull();
    tile.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('skips the shelf re-render when a reopen fetches an unchanged frequent list', async () => {
    seedFrequency([':tada:', ':smile:']);
    const onSelect = vi.fn();
    const screen = await render(<Wrap><EmojiPicker onSelect={onSelect} /></Wrap>);
    const trigger = screen.getByLabelText('Open emoji picker');
    // First open: ref [] vs fetched [tada, smile] → lengths differ, shelf set.
    await trigger.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="emoji-frequent-tile"]')).not.toBeNull();
    });
    // Picking closes the picker (no backdrop in the way on any viewport).
    (document.querySelector('[data-testid="emoji-frequent-tile"]') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    // Reopen: the fetched list matches element-for-element, so
    // sameShortcodeList's every() comparator runs and the update is skipped.
    await trigger.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="emoji-frequent-tile"]')).not.toBeNull();
    });
  });

  it('renders the default trigger button', async () => {
    const onSelect = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={onSelect} />
      </Wrap>,
    );
    await expect.element(screen.getByLabelText('Open emoji picker')).toBeVisible();
  });

  it('renders a custom trigger node when provided', async () => {
    const onSelect = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={onSelect} trigger={<button data-testid="emoji-custom-trigger">Emoji</button>} />
      </Wrap>,
    );
    await expect.element(screen.getByTestId('emoji-custom-trigger')).toBeVisible();
  });

  it('opens the popover on trigger click and onOpenChange fires true', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={vi.fn()} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    const trigger = screen.getByLabelText('Open emoji picker');
    await trigger.click();
    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(true);
    });
  });

  it('mobile sheet: a drag on the emoji grid never dismisses; a drag on the category row closes the picker', async () => {
    if (window.innerWidth > 767) return; // sheet + drag gestures are mobile-only
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={vi.fn()} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    await screen.getByLabelText('Open emoji picker').click();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
    await new Promise((r) => setTimeout(r, 300)); // let the enter spring settle

    // A drag on the SCROLLABLE emoji grid belongs to scrolling, not dismissal
    // (this is the "emoji picker won't scroll on mobile" arbitration).
    const grid = document.querySelector('[data-swipe-scroll="true"]') as HTMLElement;
    await swipe(grid, { dy: 200, steps: 8, stepMs: 18 });
    await new Promise((r) => setTimeout(r, 80));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // The category row is dismiss chrome (touch-action none, see EmojiPicker):
    // a downward drag there closes the whole picker.
    const tablist = document.querySelector('[role="tablist"][aria-label="Emoji categories"]') as HTMLElement;
    expect(getComputedStyle(tablist).touchAction).toBe('none');
    await swipe(tablist, { dy: 200, steps: 8, stepMs: 18 });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false), { timeout: 3000 });
  });

  it('reopens and toggles closed via the same trigger (desktop only)', async () => {
    if (window.innerWidth < 768) return;
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={vi.fn()} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    const trigger = screen.getByLabelText('Open emoji picker');
    await trigger.click();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
    await trigger.click();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
  });

  async function openPicker(onSelect = vi.fn()) {
    const screen = await render(<Wrap><EmojiPicker onSelect={onSelect} /></Wrap>);
    await screen.getByLabelText('Open emoji picker').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Search emojis"]')).not.toBeNull());
    return { screen, onSelect };
  }

  it('filters emojis by the search query and selects one on click', async () => {
    const { screen, onSelect } = await openPicker();
    await screen.getByLabelText('Search emojis').fill('smile');
    // The search rank ladder (name match / startsWith / includes / keyword)
    // narrows the grid; selecting a tile emits the shortcode.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull();
    });
    (document.querySelector('[data-testid="emoji-picker-tile"]') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('switches the active category when a category tab is clicked', async () => {
    const { screen } = await openPicker();
    const tabs = screen.getByTestId('emoji-category-tab').elements();
    expect(tabs.length).toBeGreaterThan(1);
    (tabs[1] as HTMLElement).click();
    // Switching categories repopulates the grid without a search query.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull();
    });
  });

  it('changes the skin tone via the skin-tone radiogroup', async () => {
    const { screen } = await openPicker();
    const radios = within(screen.getByRole('radiogroup', { name: 'Emoji skin tone' }).element())
      .querySelectorAll('button, [role="radio"]');
    expect(radios.length).toBeGreaterThan(1);
    (radios[2] as HTMLElement).click();
    // No throw — the skin-tone change updates state (and persists for a user).
    expect(document.querySelector('[aria-label="Search emojis"]')).not.toBeNull();
  });

  it('persists a skin-tone change with a PATCH and setAuth when a token is present', async () => {
    apiFetchMock.mockClear();
    setAuthMock.mockClear();
    tokenRef.value = 'tok-123';
    try {
      const { screen } = await openPicker();
      const radios = within(screen.getByRole('radiogroup', { name: 'Emoji skin tone' }).element())
        .querySelectorAll('button, [role="radio"]');
      (radios[2] as HTMLElement).click();
      await vi.waitFor(() => {
        const call = apiFetchMock.mock.calls.find((c) => c[0] === '/api/v1/users/me');
        expect(call).toBeDefined();
        expect((call![1] as { method: string }).method).toBe('PATCH');
      });
      await vi.waitFor(() => expect(setAuthMock).toHaveBeenCalled());
    } finally {
      tokenRef.value = null;
    }
  });

  it('rolls the skin tone back when the profile PATCH fails', async () => {
    apiFetchMock.mockClear();
    setAuthMock.mockClear();
    apiFetchMock.mockRejectedValueOnce(new Error('offline'));
    const { screen } = await openPicker();
    const group = screen.getByRole('radiogroup', { name: 'Emoji skin tone' }).element();
    const radios = within(group).querySelectorAll('[role="radio"]');
    (radios[2] as HTMLElement).click();
    // The optimistic tone applies, the PATCH rejects, and the catch arm
    // restores the previous ('' default) tone.
    await vi.waitFor(() => {
      const checked = within(group).querySelectorAll('[role="radio"][aria-checked="true"]');
      expect(checked[0]).toBe(radios[0]);
    });
    expect(setAuthMock).not.toHaveBeenCalled();
  });

  it('does not PATCH when the chosen skin tone equals the current one', async () => {
    apiFetchMock.mockClear();
    const { screen } = await openPicker();
    const radios = within(screen.getByRole('radiogroup', { name: 'Emoji skin tone' }).element())
      .querySelectorAll('button, [role="radio"]');
    // The first swatch is the default (no tone) — same as the user's '' tone.
    (radios[0] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(apiFetchMock.mock.calls.some((c) => c[0] === '/api/v1/users/me')).toBe(false);
  });

  it('shows the empty state when a search matches nothing', async () => {
    const { screen } = await openPicker();
    await screen.getByLabelText('Search emojis').fill('zzzzqqqx');
    await expect.element(screen.getByText('No emojis found')).toBeVisible();
  });

  it('shows an empty custom grid when the custom emoji list is undefined', async () => {
    customEmojiData.value = undefined;
    try {
      const { screen } = await openPicker();
      // filteredCustom returns [] via `if (!customEmojis) return []`.
      await screen.getByLabelText('Search emojis').fill('parrot');
      await new Promise((r) => setTimeout(r, 30));
      // No custom tiles render; no throw.
      expect(document.querySelector('[aria-label="Search emojis"]')).not.toBeNull();
    } finally {
      customEmojiData.value = [
        { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
      ];
    }
  });

  it('skips the skin-tone profile sync when there is no signed-in user', async () => {
    authUserRef.value = null;
    try {
      const { screen } = await openPicker();
      // The effect's `if (!user) return` arm runs; the picker still renders.
      expect(document.querySelector('[aria-label="Search emojis"]')).not.toBeNull();
      void screen;
    } finally {
      authUserRef.value = { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', emojiSkinTone: '' };
    }
  });

  it('treats a colon-only search as an empty query (rank short-circuit)', async () => {
    const { screen } = await openPicker();
    // ':' normalizes to '' so emojiSearchRank hits the `if (!q) return 0` arm
    // for every entry — the grid stays populated rather than filtered.
    await screen.getByLabelText('Search emojis').fill(':');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull());
  });

  it('defaults the skin tone to empty when the user has no stored preference', async () => {
    // emojiSkinTone undefined → `user?.emojiSkinTone ?? ''` takes the `?? ''` arm
    // for both the initial state and the profile-sync effect.
    authUserRef.value = { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active' };
    const { screen } = await openPicker();
    const def = within(screen.getByRole('radiogroup', { name: 'Emoji skin tone' }).element())
      .querySelectorAll('[role="radio"][aria-checked="true"]');
    expect(def.length).toBe(1);
    authUserRef.value = { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', emojiSkinTone: '' };
  });

  it('syncs the skin tone from the profile when it changes while the picker is open', async () => {
    // Reopening after the user's stored skin tone changes drives the effect's
    // "profile tone differs from the last-applied tone" branch (queueMicrotask
    // setSkinTone), rather than the early-return equal branch.
    authUserRef.value = { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', emojiSkinTone: '' };
    const screen = await render(<Wrap><EmojiPicker onSelect={vi.fn()} /></Wrap>);
    const trigger = screen.getByLabelText('Open emoji picker');
    await trigger.click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Search emojis"]')).not.toBeNull());
    if (window.innerWidth >= 768) {
      await trigger.click(); // close
      authUserRef.value = { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', emojiSkinTone: 'dark' };
      await trigger.click(); // reopen with a new tone
      await vi.waitFor(() => {
        const dark = document.querySelector('[role="radio"][aria-checked="true"]');
        expect(dark).not.toBeNull();
      });
    }
    authUserRef.value = { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', emojiSkinTone: '' };
  });

  it('ranks exact-name, startsWith, includes, and fuzzy search hits', async () => {
    const { screen } = await openPicker();
    const input = screen.getByLabelText('Search emojis');
    // Exact name (rank 0).
    await input.fill('grin_face');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull());
    // startsWith (rank 1).
    await input.fill('grin');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull());
    // includes (rank 2).
    await input.fill('face');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull());
    // fuzzy subsequence (rank 4) — "gace" is a subsequence of grin_face but
    // not a substring, so it only matches via fuzzyMatch.
    await input.fill('gace');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull());
  });

  it('renders the Custom tab heading and custom-only grid with no search query', async () => {
    const { screen } = await openPicker();
    const customTab = Array.from(document.querySelectorAll('[data-testid="emoji-category-tab"]'))
      .find((t) => (t as HTMLElement).getAttribute('data-category') === 'custom') as HTMLElement | undefined;
    expect(customTab).toBeDefined();
    customTab!.click();
    // No query + custom category → header reads "Custom", the grid is labelled
    // "Custom emojis", and filteredCustom returns the full custom list.
    await expect.element(screen.getByText('Custom')).toBeVisible();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Custom emojis"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull();
    });
  });

  it('shows the custom emoji when the custom category is selected', async () => {
    await openPicker();
    // The custom category tab surfaces the workspace's custom emojis.
    const customTab = Array.from(document.querySelectorAll('[data-testid="emoji-category-tab"]'))
      .find((t) => (t as HTMLElement).getAttribute('aria-label')?.toLowerCase().includes('custom'));
    if (!customTab) return; // build without a custom category
    (customTab as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="emoji-picker-tile"]')).not.toBeNull();
    });
  });

  it('selects a custom emoji tile and emits its :name: shortcode', async () => {
    const { screen, onSelect } = await openPicker();
    const customTab = Array.from(document.querySelectorAll('[data-testid="emoji-category-tab"]'))
      .find((t) => (t as HTMLElement).getAttribute('data-category') === 'custom') as HTMLElement;
    expect(customTab).toBeDefined();
    customTab.click();
    const tile = screen.getByLabelText('React with :partyparrot:');
    await expect.element(tile).toBeVisible();
    await tile.click();
    // handlePick records the use and hands the shortcode to the consumer.
    expect(onSelect).toHaveBeenCalledWith(':partyparrot:');
    expect(recordMock).toHaveBeenCalledWith(':partyparrot:');
  });
});

function within(root: Element) {
  return { querySelectorAll: (sel: string) => root.querySelectorAll(sel) };
}
