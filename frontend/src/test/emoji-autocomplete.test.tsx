import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-1' }] }),
}));

import { EmojiAutocomplete } from '@/components/chat/EmojiAutocomplete';

describe('EmojiAutocomplete', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
  });

  it('renders nothing when query is empty', () => {
    render(
      <EmojiAutocomplete
        query=""
        anchorRect={null}
        onPick={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('emoji-autocomplete')).toBeNull();
  });

  it('shows custom emoji match before standard matches', () => {
    render(
      <EmojiAutocomplete
        query="parr"
        anchorRect={null}
        onPick={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const opts = screen.getAllByTestId('emoji-autocomplete-option');
    expect(opts[0].textContent).toContain(':parrot:');
  });

  it('shows standard matches by name and keyword', () => {
    render(
      <EmojiAutocomplete
        query="lol"
        anchorRect={null}
        onPick={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    // :joy: has keyword "lol".
    const labels = screen.getAllByTestId('emoji-autocomplete-option').map((o) => o.textContent);
    expect(labels.some((l) => l?.includes(':joy:'))).toBe(true);
  });

  it('Enter picks the highlighted suggestion', () => {
    const onPick = vi.fn();
    render(
      <EmojiAutocomplete
        query="thumbs"
        anchorRect={null}
        onPick={onPick}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalled();
    const arg = onPick.mock.calls[0][0] as { name: string };
    expect(arg.name).toMatch(/thumbs/);
  });

  it('ArrowDown advances the active row', () => {
    render(
      <EmojiAutocomplete
        query="smi"
        anchorRect={null}
        onPick={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const initialActive = screen.getAllByTestId('emoji-autocomplete-option').filter(
      (o) => o.getAttribute('data-emoji-active') === 'true',
    );
    expect(initialActive.length).toBe(1);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    const next = screen.getAllByTestId('emoji-autocomplete-option').filter(
      (o) => o.getAttribute('data-emoji-active') === 'true',
    );
    expect(next.length).toBe(1);
    expect(next[0]).not.toBe(initialActive[0]);
  });

  it('Escape calls onDismiss', () => {
    const onDismiss = vi.fn();
    render(
      <EmojiAutocomplete
        query="smi"
        anchorRect={null}
        onPick={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('mousedown on a row picks immediately (beats focus blur)', () => {
    const onPick = vi.fn();
    render(
      <EmojiAutocomplete
        query="thumbs"
        anchorRect={null}
        onPick={onPick}
        onDismiss={vi.fn()}
      />,
    );
    const row = screen.getAllByTestId('emoji-autocomplete-option')[0];
    fireEvent.mouseDown(row);
    expect(onPick).toHaveBeenCalled();
  });
});
