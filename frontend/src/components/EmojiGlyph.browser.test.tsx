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

  it('uses the lg size classes when size="lg"', async () => {
    await render(<EmojiGlyph emoji=":smile:" size="lg" />);
    const span = document.querySelector('span[title=":smile:"]') as HTMLSpanElement;
    // lg maps the text glyph to the 22px ramp step.
    expect(span.className).toMatch(/text-\[22px\]/);
  });

  it('uses the lg image class for a custom emoji when size="lg"', async () => {
    await render(
      <EmojiGlyph emoji=":custom_party:" size="lg" customMap={{ custom_party: 'https://cdn.test/p.png' }} />,
    );
    const img = document.querySelector('img[alt=":custom_party:"]') as HTMLImageElement;
    expect(img.className).toMatch(/h-\[22px\]/);
  });

  it('keeps the raw toned shortcode when its base is an unknown shortcode', async () => {
    // `:notarealemoji:` has no unicode mapping, so shortcodeToUnicode
    // returns the base unchanged → the `unicode === base` arm keeps the
    // original toned string verbatim rather than applying a skin tone.
    await render(<EmojiGlyph emoji=":notarealemoji::skin-tone-3:" />);
    const span = document.querySelector('span[title=":notarealemoji::skin-tone-3:"]') as HTMLSpanElement;
    expect(span).not.toBeNull();
    expect(span.textContent).toBe(':notarealemoji::skin-tone-3:');
  });
});
