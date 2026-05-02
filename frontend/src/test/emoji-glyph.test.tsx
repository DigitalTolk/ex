import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { EmojiGlyph } from '@/components/EmojiGlyph';

describe('EmojiGlyph (shared 14px renderer)', () => {
  it('renders custom emoji as <img> at h-3.5 w-3.5', () => {
    const { container } = render(
      <EmojiGlyph emoji=":party:" customMap={{ party: 'http://x/p.png' }} />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('http://x/p.png');
    expect(img?.className).toContain('h-3.5');
    expect(img?.className).toContain('w-3.5');
  });

  it('renders shortcode unicode as text-sm span', () => {
    const { container } = render(<EmojiGlyph emoji=":+1:" />);
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    expect(span?.className).toContain('text-sm');
  });

  it('renders full picker-catalog shortcodes that are not in common typeahead aliases', () => {
    const { container } = render(<EmojiGlyph emoji=":grin_squint_face:" />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe('😆');
  });

  it('renders raw unicode as text-sm span', () => {
    const { container } = render(<EmojiGlyph emoji="🎉" />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe('🎉');
    expect(span?.className).toContain('text-sm');
  });

  it('renders split skin-tone shortcodes as one toned glyph', () => {
    const { container } = render(<EmojiGlyph emoji=":hand::skin-tone-3:" />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe('🖐🏽');
    expect(span?.className).toContain('text-sm');
  });

  it('falls back to literal text for unknown shortcodes', () => {
    const { container } = render(<EmojiGlyph emoji=":not_a_real_emoji:" />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe(':not_a_real_emoji:');
  });

  it('size="lg" upsizes both image and unicode glyphs for the picker', () => {
    // 22px is the picker glyph size — 2px smaller than the previous text-2xl
    // baseline so the picker grid feels less heavy without losing readability.
    const imgRender = render(
      <EmojiGlyph emoji=":party:" size="lg" customMap={{ party: 'http://x/p.png' }} />,
    );
    const img = imgRender.container.querySelector('img');
    expect(img?.className).toContain('h-[22px]');
    expect(img?.className).toContain('w-[22px]');

    const unicodeRender = render(<EmojiGlyph emoji="🎉" size="lg" />);
    const span = unicodeRender.container.querySelector('span');
    expect(span?.className).toContain('text-[22px]');
  });
});
