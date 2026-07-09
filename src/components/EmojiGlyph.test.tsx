import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { EmojiGlyph } from './EmojiGlyph';

describe('EmojiGlyph', () => {
  it('applies the skin tone to a known toned shortcode', () => {
    // :wave: resolves to 👋, so the skin-tone suffix branch produces 👋🏼.
    const { container } = render(<EmojiGlyph emoji=":wave::skin-tone-2:" />);
    const span = container.querySelector('span')!;
    expect(span).toHaveAttribute('title', ':wave::skin-tone-2:');
    expect(span.textContent).toBe('👋🏼');
  });

  it('falls back to the raw shortcode when the toned base is unknown', () => {
    // :raised_hand: is not in the unicode map, so unicode === base and the
    // component renders the original toned shortcode verbatim.
    const { container } = render(<EmojiGlyph emoji=":raised_hand::skin-tone-2:" />);
    const span = container.querySelector('span')!;
    expect(span.textContent).toBe(':raised_hand::skin-tone-2:');
  });

  it('renders a custom emoji image when the name resolves in customMap', () => {
    const { container } = render(
      <EmojiGlyph emoji=":party_parrot:" customMap={{ party_parrot: 'https://x/parrot.gif' }} />,
    );
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://x/parrot.gif');
    expect(img).toHaveAttribute('alt', ':party_parrot:');
  });

  it('renders a unicode glyph for a known shortcode without a custom map entry', () => {
    const { container } = render(<EmojiGlyph emoji=":wave:" />);
    const span = container.querySelector('span')!;
    expect(span.textContent).toBe('👋');
  });

  it('passes through a plain (non-shortcode) emoji unchanged', () => {
    const { container } = render(<EmojiGlyph emoji="🎉" />);
    const span = container.querySelector('span')!;
    expect(span.textContent).toBe('🎉');
  });

  it('uses the xl sizing classes on a custom image', () => {
    const { container } = render(
      <EmojiGlyph
        emoji=":party_parrot:"
        size="xl"
        customMap={{ party_parrot: 'https://x/parrot.gif' }}
      />,
    );
    expect(container.querySelector('img')).toHaveClass('h-16', 'w-16');
  });

  it('uses the lg text sizing on a unicode glyph', () => {
    const { container } = render(<EmojiGlyph emoji="🎉" size="lg" />);
    expect(container.querySelector('span')).toHaveClass('text-[22px]');
  });

  it('uses the md (16px) sizing on a unicode glyph', () => {
    const { container } = render(<EmojiGlyph emoji="🎉" size="md" />);
    expect(container.querySelector('span')).toHaveClass('text-base');
  });

  it('uses the md sizing classes on a custom image', () => {
    const { container } = render(
      <EmojiGlyph emoji=":party_parrot:" size="md" customMap={{ party_parrot: 'https://x/parrot.gif' }} />,
    );
    expect(container.querySelector('img')).toHaveClass('h-4', 'w-4');
  });
});
