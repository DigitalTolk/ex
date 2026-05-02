import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from '@/lib/markdown';

// Body emojis render at 1.4em (relative to surrounding font-size) so
// they stay legible alongside the 14px message text without dwarfing
// the line and — crucially — scale up automatically when wrapped in a
// heading (`# Title :party_popper:` keeps the emoji proportional to H1).
describe('Emoji sizing — 1.4em in message body', () => {
  it('inline custom emoji image uses h-[1.4em] w-[1.4em]', () => {
    const { container } = render(
      <>{renderMarkdown(':smile:', { emojiMap: { smile: 'http://x/smile.png' } })}</>,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.className).toContain('h-[1.4em]');
    expect(img?.className).toContain('w-[1.4em]');
  });

  it('shortcode-resolved unicode emoji uses text-[1.4em] hero size', () => {
    const { container } = render(<>{renderMarkdown(':grin_face_smile_eyes:')}</>);
    const span = container.querySelector('span[title=":grin_face_smile_eyes:"]');
    expect(span).not.toBeNull();
    expect(span?.className).toContain('text-[1.4em]');
  });

  it('inline custom emoji image is vertically centered with align-middle', () => {
    const { container } = render(
      <>{renderMarkdown('hello :smile: world', { emojiMap: { smile: 'http://x/smile.png' } })}</>,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    // align-middle (not align-text-bottom) sits the glyph on the x-height
    // so it reads as visually centered with the surrounding text.
    expect(img?.className).toContain('align-middle');
    expect(img?.className).not.toContain('align-text-bottom');
  });

  it('custom emoji inside a heading scales with the heading via em-based sizing', () => {
    const { container } = render(
      <>{renderMarkdown('# Welcome :tada:', { emojiMap: { tada: 'http://x/tada.png' } })}</>,
    );
    const h1 = container.querySelector('h1');
    expect(h1).not.toBeNull();
    const img = h1?.querySelector('img');
    expect(img).not.toBeNull();
    // Em-based sizing means the rendered pixel size is computed from the
    // h1's font-size (text-2xl = 24px) so the emoji is ~33.6px instead
    // of being stuck at the 20px paragraph baseline.
    expect(img?.className).toContain('h-[1.4em]');
    expect(img?.className).toContain('w-[1.4em]');
  });

  it('unicode emoji inside a heading also scales via em-based sizing', () => {
    const { container } = render(<>{renderMarkdown('## Hi :grin_face_smile_eyes:')}</>);
    const h2 = container.querySelector('h2');
    expect(h2).not.toBeNull();
    const span = h2?.querySelector('span[title=":grin_face_smile_eyes:"]');
    expect(span).not.toBeNull();
    expect(span?.className).toContain('text-[1.4em]');
  });
});
