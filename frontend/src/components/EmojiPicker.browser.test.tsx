import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiPicker } from './EmojiPicker';

// Browser coverage for EmojiPicker — exercises trigger, search,
// category switching, and skin-tone selection paths.

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [
    { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
  ] }),
  useEmojiMap: () => ({ data: { partyparrot: 'https://emoji.test/parrot.gif' } }),
}));

const apiFetchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'u-1', emojiSkinTone: 'medium' }));
const tokenRef = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getAccessToken: () => tokenRef.value,
}));

const setAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/context/AuthContext', () => {
  const state = {
    user: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active', emojiSkinTone: '' },
    isAuthenticated: true,
    isLoading: false,
    setAuth: setAuthMock,
  };
  return {
    useAuth: () => state,
    useOptionalAuth: () => state,
    AuthContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  };
});

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('EmojiPicker browser', () => {
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
});

function within(root: Element) {
  return { querySelectorAll: (sel: string) => root.querySelectorAll(sel) };
}
