import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiPicker } from './EmojiPicker';

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
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
    // Picker now opens on the first category — search for the legacy
    // `:thumbsup:` alias to surface its tile.
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

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on outside click', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <EmojiPicker onSelect={vi.fn()} />
        <button>outside</button>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('outside'));
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

  it('uses larger monochrome SVG category tabs in a narrower picker', async () => {
    const user = userEvent.setup();
    render(<EmojiPicker onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open emoji picker/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('w-[304px]');

    const tabs = screen.getAllByTestId('emoji-category-tab');
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs[0].className).toContain('h-9');
    expect(tabs[0].className).toContain('w-9');
    expect(tabs[0].querySelector('svg')).not.toBeNull();
    expect(tabs[0].textContent).toBe('');
  });
});
