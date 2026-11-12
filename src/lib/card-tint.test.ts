import { describe, expect, it } from 'vitest';
import { cardClass, cardTint } from './card-tint';

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

  it("edges a tinted card in its own hue, and the plain card in the theme's", () => {
    expect(cardClass('danger')).toBe('bg-rt-red-bg border-rt-red/15');
    expect(cardClass()).toBe('border-border bg-background');
  });
});
