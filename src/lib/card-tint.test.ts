import { describe, expect, it } from 'vitest';
import { cardClass, cardTint, HUE_TEXT, QUOTE_CARD } from './card-tint';

describe('cardTint', () => {
  it('takes a palette name as is, and no colour as the theme default', () => {
    expect(cardTint('green')).toBe('green');
    expect(cardTint(' Purple ')).toBe('purple');
    for (const none of [undefined, '', 'default', 'not-a-color', 'constructor']) expect(cardTint(none)).toBeNull();
  });

  it("maps Slack's names and any hex to the nearest palette hue", () => {
    const want: Record<string, string> = {
      good: 'green',
      warning: 'yellow',
      danger: 'red',
      '#36a64f': 'green',
      '#0a0': 'green',
      '#ff0000': 'red',
      '#e01e5a': 'red',
      '#ff8000': 'orange',
      '#8b4513': 'brown',
      '#daa038': 'orange',
      '#ffd400': 'yellow',
      '#439FE0': 'blue',
      '#22d3ee': 'blue',
      '#7c3aed': 'purple',
      '#c026d3': 'purple',
      '#888': 'gray',
      '#000000': 'gray',
    };
    expect(Object.fromEntries(Object.keys(want).map((c) => [c, cardTint(c)]))).toEqual(want);
  });

  it("outlines a coloured card from its own hue, and the plain card in the theme's border", () => {
    // No fill and no side bar: .card-outline reads the hue from --card-hue.
    expect(cardClass('danger')).toBe('card-outline [--card-hue:var(--color-rt-red)]');
    expect(cardClass('#0a0')).toBe('card-outline [--card-hue:var(--color-rt-green)]');
    expect(cardClass()).toBe('border border-border bg-background');
    expect(cardClass('not-a-color')).toBe('border border-border bg-background');
  });

  it('gives a quoted message and a link preview the same card in grey', () => {
    expect(QUOTE_CARD).toBe(cardClass('gray'));
  });

  it("colours a card's status icon in the card's hue", () => {
    expect(HUE_TEXT.red).toBe('text-rt-red');
    expect(Object.keys(HUE_TEXT).sort()).toEqual(['blue', 'brown', 'gray', 'green', 'orange', 'purple', 'red', 'yellow']);
  });
});
