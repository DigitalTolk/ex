import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render as rtlRender, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiPicker } from './EmojiPicker';
import { getFrequentEmojis } from '@/lib/emoji-frequency';

// EmojiPicker renders inside PopoverPortal, whose Motion swipe hook runs a
// mount animation that hangs jsdom; stub it and capture the swipe-down
// dismiss callback so the dismiss path can be driven directly (drag
// physics are unit-tested in useSwipeDismiss.test).
const swipe = vi.hoisted(() => ({ fire: undefined as (() => void) | undefined }));
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: (_dir: string, onDismiss: () => void) => {
    swipe.fire = onDismiss;
    return { dismissing: false, motionProps: {} };
  },
}));

const authMock = vi.hoisted(() => ({
  user: {
    id: 'u-1',
    email: 'u@example.com',
    displayName: 'User',
    systemRole: 'member' as const,
    status: 'active',
    emojiSkinTone: '' as const,
  },
  setAuth: vi.fn(),
}));

// Custom-emoji catalog (drives the "Getting Work Done" shelf). Seedable per
// test so the work-pack dedup and landing-page gating can be exercised.
const emojisRef = vi.hoisted(() => ({
  value: [] as Array<{ name: string; imageURL: string; gettingWorkDone?: boolean }>,
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: emojisRef.value }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/context/AuthContext', () => ({
  useOptionalAuth: () => authMock,
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => 'tok',
}));

// Server-backed frequently-used shelf — mocked so the list is deterministic
// and picks can be asserted without a backend.
const freqRef = vi.hoisted(() => ({ value: [] as string[] }));
const recordMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/emoji-frequency', () => ({
  EMOJI_FREQUENCY_CHANGED_EVENT: 'emoji-frequency-changed',
  // Mirror the server's limit-honouring slice so the desktop/mobile row caps
  // are exercised here exactly as in production.
  getFrequentEmojis: vi.fn(async (limit: number) => freqRef.value.slice(0, limit)),
  recordEmojiUse: (shortcode: string) => recordMock(shortcode),
}));

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

function seedFrequency(shortcodes: string[]) {
  freqRef.value = shortcodes;
}

describe('EmojiPicker', () => {
  beforeEach(() => {
    freqRef.value = [];
    emojisRef.value = [];
    recordMock.mockClear();
  });

  function seedWorkPack(entries: Array<{ name: string; gettingWorkDone?: boolean }>) {
    emojisRef.value = entries.map((e) => ({
      imageURL: `https://cdn.example/${e.name}.png`,
      gettingWorkDone: true,
      ...e,
    }));
  }

  it('renders trigger and is closed by default', () => {
    render(<EmojiPicker onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /open emoji picker/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens picker when trigger clicked', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('calls onSelect with shortcode when an emoji is clicked', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    // Picker opens on the first category; search for a generated
    // shortcode to surface its tile.
    await user.type(screen.getByLabelText('Search emojis'), 'thumbsup');
    await user.click(screen.getByLabelText('React with :thumbsup:'));

    expect(onSelect).toHaveBeenCalledWith(':thumbsup:');
  });

  it('closes picker after selection', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search emojis'), 'tada');
    await user.click(screen.getByLabelText('React with :tada:'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not autofocus the search field on mobile', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    expect(screen.getByRole('dialog')).toHaveAttribute('data-mobile-sheet', 'true');
    expect(document.activeElement).not.toBe(screen.getByLabelText('Search emojis'));
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('blurs the search field before closing after selection', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    const search = screen.getByLabelText('Search emojis');
    expect(document.activeElement).toBe(search);
    await user.type(search, 'tada');
    await user.click(screen.getByLabelText('React with :tada:'));

    expect(document.activeElement).not.toBe(search);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the shortest shortcode match first when searching', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    await user.type(screen.getByLabelText('Search emojis'), 'bow');

    await waitFor(() => {
      expect(screen.getAllByTestId('emoji-picker-tile')[0]).toHaveAccessibleName('React with :bow:');
    });
    expect(screen.getAllByTestId('emoji-picker-tile').findIndex((row) => row.getAttribute('aria-label') === 'React with :rainbow:')).toBeGreaterThan(0);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on outside pointer press', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <EmojiPicker onSelect={vi.fn()} />
        <button>outside</button>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a custom trigger when provided', () => {
    render(<EmojiPicker onSelect={vi.fn()} trigger={<span>Custom Trigger</span>} />);
    expect(screen.getByText('Custom Trigger')).toBeInTheDocument();
  });

  it('calls onClose when picker closes', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('toggles open/closed when trigger is re-clicked', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /open emoji picker/i });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses larger monochrome SVG category tabs, nine emoji columns, and a custom tab at the right', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('w-[336px]');
    expect(dialog.className).toContain('h-[460px]');
    expect(dialog.className).toContain('mobile:h-[50dvh]');

    const tabs = screen.getAllByTestId('emoji-category-tab');
    expect(tabs).toHaveLength(10);
    expect(tabs[0].className).toContain('h-7');
    expect(tabs[0].className).toContain('w-7');
    expect(tabs[0].querySelector('svg')).not.toBeNull();
    expect(tabs[0].textContent).toBe('');
    expect(tabs[tabs.length - 1]).toHaveAttribute('data-category', 'custom');
    expect(screen.getByRole('tablist', { name: /emoji categories/i }).className).toContain('justify-center');
    expect(screen.getByRole('list', { name: /standard emojis/i }).className).toContain('grid-cols-[repeat(9,2rem)]');
  });

  it('uses larger emoji tap targets on mobile', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const list = screen.getByRole('list', { name: /standard emojis/i });
    const tile = screen.getAllByTestId('emoji-picker-tile')[0];

    expect(list.className).toContain('mobile:grid-cols-[repeat(7,2.75rem)]');
    expect(tile.className).toContain('mobile:h-11');
    expect(tile.className).toContain('mobile:w-11');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('caps the mobile sheet at half the viewport and contains its own scroll', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-mobile-sheet', 'true');
    expect(dialog.className).toContain('mobile:h-[50dvh]');
    expect(dialog).toHaveStyle({ maxHeight: '50dvh', overscrollBehaviorY: 'contain' });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('closes the mobile sheet via the swipe-down dismiss', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    screen.getByRole('dialog');
    act(() => swipe.fire?.());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('reopens the mobile sheet after it was dismissed by swiping down', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    screen.getByRole('dialog');
    act(() => swipe.fire?.());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    const reopened = screen.getByRole('dialog');
    expect(reopened).toBeInTheDocument();
    expect(reopened).toHaveAttribute('data-swipe-dismissing', 'false');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('places the skin tone selector below the emoji grid', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const list = screen.getByRole('list', { name: /standard emojis/i });
    const skinToneSelector = screen.getByRole('radiogroup', { name: /emoji skin tone/i });

    expect(list.compareDocumentPosition(skinToneSelector) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(skinToneSelector.className).toContain('mt-1.5');
    expect(skinToneSelector.className).toContain('border-t');
  });

  it('does not render a frequently-used shelf with no history', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    expect(screen.queryByRole('list', { name: /frequently used emojis/i })).not.toBeInTheDocument();
  });

  it('shows up to two rows of the most-used emojis at the top', async () => {
    // Seed 20 entries — desktop shows 9 cols × 2 rows = 18.
    seedFrequency(Array.from({ length: 20 }, (_, i) => `:freq${i}:`));
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const shelf = await screen.findByRole('list', { name: /frequently used emojis/i });
    expect(within(shelf).getAllByTestId('emoji-frequent-tile')).toHaveLength(18);
    expect(screen.getByText('Frequently used')).toBeInTheDocument();
  });

  it('caps the frequently-used shelf to two rows of seven on mobile', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    seedFrequency(Array.from({ length: 20 }, (_, i) => `:freq${i}:`));
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const shelf = await screen.findByRole('list', { name: /frequently used emojis/i });
    expect(within(shelf).getAllByTestId('emoji-frequent-tile')).toHaveLength(14);
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('selects a frequently-used emoji when its tile is clicked', async () => {
    seedFrequency([':tada:']);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const shelf = await screen.findByRole('list', { name: /frequently used emojis/i });
    await user.click(within(shelf).getByTestId('emoji-frequent-tile'));
    expect(onSelect).toHaveBeenCalledWith(':tada:');
    expect(recordMock).toHaveBeenCalledWith(':tada:');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hides the frequently-used shelf while searching', async () => {
    seedFrequency([':tada:']);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    expect(await screen.findByRole('list', { name: /frequently used emojis/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search emojis'), 'thumbsup');
    expect(screen.queryByRole('list', { name: /frequently used emojis/i })).not.toBeInTheDocument();
  });

  it('over-fetches so the shelf still fills two full rows after work-pack dedup', async () => {
    // Regression for the "15 not 18" report: three of the user's most-used
    // emojis are ALSO pinned in "Getting Work Done". They're deduped out of the
    // frequent shelf (rendering a tile twice wastes a slot) — but because the
    // frequent list is over-fetched past the two visible rows, the slice still
    // yields a full 18 rather than 18-minus-the-pinned.
    seedWorkPack([{ name: 'wp0' }, { name: 'wp1' }, { name: 'wp2' }]);
    seedFrequency([
      ':wp0:',
      ':wp1:',
      ':wp2:',
      ...Array.from({ length: 18 }, (_, i) => `:freq${i}:`),
    ]);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    // The over-fetch limit (well past two rows) is what gives dedup room to fill.
    expect(getFrequentEmojis).toHaveBeenCalledWith(50);
    const shelf = await screen.findByRole('list', { name: /frequently used emojis/i });
    expect(within(shelf).getAllByTestId('emoji-frequent-tile')).toHaveLength(18);
    // The pinned work-pack emojis do NOT also appear in the frequent shelf.
    expect(within(shelf).queryByLabelText('React with :wp0:')).not.toBeInTheDocument();
    // They live in the work-pack shelf instead.
    const work = screen.getByRole('list', { name: /getting work done emojis/i });
    expect(within(work).getAllByTestId('emoji-workpack-tile')).toHaveLength(3);
  });

  it('shows the frequent + work-pack shelves only on the landing tab', async () => {
    seedWorkPack([{ name: 'wp0' }]);
    seedFrequency([':tada:', ':smile:']);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    // Landing (first category tab): both shelves present.
    expect(await screen.findByRole('list', { name: /frequently used emojis/i })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /getting work done emojis/i })).toBeInTheDocument();

    // Switch to another category — the shelves belong to the landing view only.
    const tabs = screen.getAllByTestId('emoji-category-tab');
    const other = tabs.find((t) => t.getAttribute('data-category') !== tabs[0].getAttribute('data-category'))!;
    await user.click(other);

    expect(screen.queryByRole('list', { name: /frequently used emojis/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /getting work done emojis/i })).not.toBeInTheDocument();
    // The picked category's own grid is still shown.
    expect(screen.getByRole('list', { name: /standard emojis/i })).toBeInTheDocument();
  });

  it('records each picked emoji to the server-backed shelf', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    await user.type(screen.getByLabelText('Search emojis'), 'thumbsup');
    await user.click(screen.getByLabelText('React with :thumbsup:'));
    expect(recordMock).toHaveBeenCalledWith(':thumbsup:');
  });

  it('applies selected skin tone to supported standard emoji picks', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    await user.click(screen.getByRole('radio', { name: /medium skin tone/i }));
    await user.type(screen.getByLabelText('Search emojis'), 'thumbsup');
    await user.click(screen.getByLabelText('React with :thumbsup::skin-tone-3:'));

    expect(onSelect).toHaveBeenCalledWith(':thumbsup::skin-tone-3:');
  });
});
