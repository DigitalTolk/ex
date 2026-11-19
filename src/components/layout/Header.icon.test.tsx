import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';
import { Header } from './Header';
import type { Channel } from '@/types';

// A channel's icon: whoever may edit the channel changes its emoji by clicking
// the icon in the header, and removes it from the channel menu. A private
// channel keeps a small lock beside its name once an emoji takes the lock's
// place. The picker has its own tests; here it is its trigger and one emoji.

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/EmojiPicker', () => ({
  EmojiPicker: ({ onSelect, trigger, ariaLabel }: { onSelect: (emoji: string) => void; trigger: ReactNode; ariaLabel?: string }) => (
    <span data-testid="emoji-picker" aria-label={ariaLabel}>
      {trigger}
      <button type="button" onClick={() => onSelect(':rocket:')}>
        Pick rocket
      </button>
    </span>
  ),
}));

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    name: 'launch-prep',
    slug: 'launch-prep',
    type: 'public',
    createdBy: 'user-1',
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderHeader(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
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

describe('Header channel icon', () => {
  beforeEach(() => {
    setMobileMatch(false);
  });

  it('lets an editor change the icon by clicking it, and draws the icon once', async () => {
    const user = userEvent.setup();
    const onIconChange = vi.fn();
    renderHeader(<Header channel={makeChannel({ icon: 'tada' })} canEdit onIconChange={onIconChange} />);

    const button = screen.getByTestId('channel-icon-button');
    expect(button).toHaveAccessibleName('Change channel icon');
    expect(screen.getByTestId('emoji-picker')).toHaveAccessibleName('Channel icon');
    // The emoji is the button's face; the title beside it does not repeat it.
    expect(within(button).getByTestId('channel-emoji')).toBeInTheDocument();
    expect(screen.getAllByTestId('channel-emoji')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Pick rocket' }));
    expect(onIconChange).toHaveBeenCalledWith(':rocket:');
  });

  it('shows the globe as the button face of a channel with no emoji yet', () => {
    renderHeader(<Header channel={makeChannel()} canEdit onIconChange={vi.fn()} />);
    const button = screen.getByTestId('channel-icon-button');
    expect(button.querySelector('svg.lucide-globe')).not.toBeNull();
    expect(screen.queryByTestId('channel-emoji')).toBeNull();
    expect(document.querySelectorAll('svg.lucide-globe')).toHaveLength(1);
  });

  it('shows the icon as a plain mark to someone who cannot change it', () => {
    renderHeader(<Header channel={makeChannel({ icon: 'tada' })} />);
    expect(screen.queryByTestId('channel-icon-button')).toBeNull();
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
    expect(screen.getByTestId('channel-emoji')).toHaveAccessibleName('Public channel');
  });

  it('keeps the icon a plain mark on a phone, where the menu is the way in', () => {
    setMobileMatch(true);
    renderHeader(<Header channel={makeChannel({ icon: 'tada' })} canEdit onIconChange={vi.fn()} />);
    expect(screen.queryByTestId('channel-icon-button')).toBeNull();
    expect(screen.getByTestId('channel-emoji')).toBeInTheDocument();
  });

  it('keeps a lock beside the name of a private channel that has an emoji', () => {
    const { unmount } = renderHeader(<Header channel={makeChannel({ type: 'private', icon: 'tada' })} />);
    expect(screen.getByTestId('channel-private-mark')).toHaveAccessibleName('Private');
    expect(screen.getByTestId('channel-emoji')).toHaveAccessibleName('Private channel');
    unmount();
    // Without an emoji the lock is the icon itself, and a public channel
    // needs no mark at all.
    const noEmoji = renderHeader(<Header channel={makeChannel({ type: 'private' })} />);
    expect(screen.queryByTestId('channel-private-mark')).toBeNull();
    expect(document.querySelector('svg.lucide-lock')).not.toBeNull();
    noEmoji.unmount();
    renderHeader(<Header channel={makeChannel({ icon: 'tada' })} />);
    expect(screen.queryByTestId('channel-private-mark')).toBeNull();
  });

  it('removes the icon from the channel menu', async () => {
    const user = userEvent.setup();
    const onIconChange = vi.fn();
    renderHeader(<Header channel={makeChannel({ icon: 'tada' })} canEdit onIconChange={onIconChange} />);
    await user.click(screen.getByText('launch-prep').closest('button')!);
    await user.click(await screen.findByRole('menuitem', { name: 'Remove icon' }));
    expect(onIconChange).toHaveBeenCalledWith('');
  });

  it('offers no "Remove icon" when there is none, or when the icon cannot be changed', async () => {
    const user = userEvent.setup();
    const first = renderHeader(<Header channel={makeChannel()} canEdit onRename={vi.fn()} onIconChange={vi.fn()} />);
    await user.click(screen.getByText('launch-prep').closest('button')!);
    expect(await screen.findByRole('menuitem', { name: 'Rename channel' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Remove icon' })).toBeNull();
    first.unmount();

    renderHeader(<Header channel={makeChannel({ icon: 'tada' })} canEdit onRename={vi.fn()} />);
    await user.click(screen.getByText('launch-prep').closest('button')!);
    expect(await screen.findByRole('menuitem', { name: 'Rename channel' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Remove icon' })).toBeNull();
  });
});
