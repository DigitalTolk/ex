import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageRichAttachments } from './MessageRichAttachments';

// The card's outline is CSS (.card-outline in index.css), so only a real
// browser can say what it paints.
describe('a webhook card in a real browser', () => {
  const card = () => getComputedStyle(document.querySelector('[data-testid="message-rich-attachment"]') as HTMLElement);

  it("brackets a coloured card's left side in its colour, with no fade", async () => {
    await render(<MessageRichAttachments attachments={[{ color: 'danger', title: 'bastion went down' }]} />);
    const s = card();
    for (const width of [s.borderLeftWidth, s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth]) {
      expect(width).toBe('2px');
    }
    // Three flat layers: the surface, the corner mark, the border. Each is
    // one colour from end to end, so nothing fades.
    const layers = [...s.backgroundImage.matchAll(/linear-gradient\((.+?\)), (.+?\))\)/g)];
    expect(layers).toHaveLength(3);
    for (const [, from, to] of layers) expect(from).toBe(to);
    // The bracket is the whole left edge and 18px along the top and the
    // bottom, not the whole border; the rest of the border is another colour.
    expect(s.backgroundSize).toContain('18px 100%');
    expect(layers[1][1]).not.toBe(layers[2][1]);
  });

  it('gives a card with no colour the ordinary border and no corner mark', async () => {
    await render(<MessageRichAttachments attachments={[{ title: 'Nightly report' }]} />);
    const s = card();
    expect(s.borderTopWidth).toBe('2px');
    expect(s.backgroundImage).toBe('none');
  });
});
