import { describe, it, expect, vi } from 'vitest';
import { act, render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiPicker } from './EmojiPicker';

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

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/context/AuthContext', () => ({
  useOptionalAuth: () => authMock,
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => 'tok',
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

function swipeDown(element: Element) {
  fireEvent.touchStart(element, { touches: [{ clientX: 160, clientY: 120 }] });
  fireEvent.touchMove(element, { touches: [{ clientX: 168, clientY: 230 }] });
  fireEvent.touchEnd(element, { changedTouches: [{ clientX: 168, clientY: 230 }] });
}

describe('EmojiPicker', () => {
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
    expect(dialog.className).toContain('max-md:h-[50dvh]');

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

    expect(list.className).toContain('max-md:grid-cols-[repeat(7,2.75rem)]');
    expect(tile.className).toContain('max-md:h-11');
    expect(tile.className).toContain('max-md:w-11');
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
    expect(dialog.className).toContain('max-md:h-[50dvh]');
    expect(dialog).toHaveStyle({ maxHeight: '50dvh', overscrollBehaviorY: 'contain' });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('closes the mobile sheet on swipe down', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const dialog = screen.getByRole('dialog');
    vi.useFakeTimers();
    swipeDown(dialog);

    expect(dialog).toHaveAttribute('data-swipe-dismissing', 'true');
    expect(dialog).toHaveClass('translate-y-full');
    act(() => vi.advanceTimersByTime(180));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.useRealTimers();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('reopens the mobile sheet after it was dismissed by swiping down', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const dialog = screen.getByRole('dialog');
    vi.useFakeTimers();
    swipeDown(dialog);
    act(() => vi.advanceTimersByTime(180));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.useRealTimers();

    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    const reopened = screen.getByRole('dialog');
    expect(reopened).toBeInTheDocument();
    expect(reopened).toHaveAttribute('data-swipe-dismissing', 'false');
    expect(reopened).not.toHaveClass('translate-y-full');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('keeps the mobile sheet open on a diagonal downward swipe', async () => {
    const originalMatchMedia = window.matchMedia;
    setMobileMatch(true);
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const dialog = screen.getByRole('dialog');
    fireEvent.touchStart(dialog, { touches: [{ clientX: 80, clientY: 120 }] });
    fireEvent.touchMove(dialog, { touches: [{ clientX: 180, clientY: 230 }] });
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 180, clientY: 230 }] });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
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
