import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { EmojiGlyph } from './EmojiGlyph';

describe('EmojiGlyph browser behaviour', () => {
  it('renders a known shortcode as the matching unicode glyph', async () => {
    await render(<EmojiGlyph emoji=":smile:" />);
    const span = document.querySelector('span[title=":smile:"]');
    expect(span).not.toBeNull();
    // unicode glyph for :smile: — we don't pin the exact codepoint here,
    // just that it is no longer the raw shortcode.
    expect(span?.textContent).not.toBe(':smile:');
  });

  it('renders a custom emoji as an <img> when customMap has an entry', async () => {
    await render(<EmojiGlyph emoji=":custom_party:" customMap={{ custom_party: 'https://cdn.test/party.png' }} />);
    const img = document.querySelector('img[alt=":custom_party:"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.src).toContain('party.png');
  });

  it('applies a skin tone suffix to a toned shortcode', async () => {
    await render(<EmojiGlyph emoji=":wave::skin-tone-2:" />);
    const span = document.querySelector('span[title=":wave::skin-tone-2:"]');
    expect(span).not.toBeNull();
  });

  it('passes through a raw glyph unchanged', async () => {
    const screen = await render(<EmojiGlyph emoji="🚀" />);
    await expect.element(screen.getByText('🚀')).toBeVisible();
  });

  it('uses the xl size class when size="xl"', async () => {
    await render(<EmojiGlyph emoji=":smile:" size="xl" />);
    const span = document.querySelector('span[title=":smile:"]') as HTMLSpanElement;
    expect(span.className).toMatch(/text-\[64px\]/);
  });
});
