import type { RichColor } from '@/types';

// The tint each palette colour paints a box with (callouts, pills, cards),
// from the theme's own tokens so light and dark each get their step.
export const TINT: Record<RichColor, string> = {
  gray: 'bg-rt-gray-bg',
  brown: 'bg-rt-brown-bg',
  orange: 'bg-rt-orange-bg',
  yellow: 'bg-rt-yellow-bg',
  green: 'bg-rt-green-bg',
  blue: 'bg-rt-blue-bg',
  purple: 'bg-rt-purple-bg',
  red: 'bg-rt-red-bg',
};

const SLACK: Record<string, RichColor> = { good: 'green', warning: 'yellow', danger: 'red' };

// cardTint is the palette colour a card's `color` tints it with, or null for
// the theme's plain card. Apps name a palette colour; older senders send
// Slack's good/warning/danger or a hex, which takes the nearest palette hue —
// so a card never paints a sender's raw colour.
export function cardTint(color?: string): RichColor | null {
  const c = color?.trim().toLowerCase() ?? '';
  if (Object.hasOwn(TINT, c)) return c as RichColor;
  if (Object.hasOwn(SLACK, c)) return SLACK[c];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((d) => d + d).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma < 0.15) return 'gray';
  const hue = max === r ? (((g - b) / chroma) * 60 + 360) % 360 : max === g ? ((b - r) / chroma) * 60 + 120 : ((r - g) / chroma) * 60 + 240;
  if (hue < 15 || hue >= 330) return 'red';
  if (hue < 45) return max < 0.55 ? 'brown' : 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 170) return 'green';
  if (hue < 255) return 'blue';
  return 'purple';
}

// A card with a colour marks the top-left corner of its border in that hue
// (.card-outline in index.css reads --card-hue). No fill and no side bar:
// the hue is a hint, and the card's status icon carries the meaning for
// anyone who can't tell the hues apart.
const HUE: Record<RichColor, string> = {
  gray: '[--card-hue:var(--color-rt-gray)]',
  brown: '[--card-hue:var(--color-rt-brown)]',
  orange: '[--card-hue:var(--color-rt-orange)]',
  yellow: '[--card-hue:var(--color-rt-yellow)]',
  green: '[--card-hue:var(--color-rt-green)]',
  blue: '[--card-hue:var(--color-rt-blue)]',
  purple: '[--card-hue:var(--color-rt-purple)]',
  red: '[--card-hue:var(--color-rt-red)]',
};

// The hue as a text colour, for the card's status icon.
export const HUE_TEXT: Record<RichColor, string> = {
  gray: 'text-rt-gray',
  brown: 'text-rt-brown',
  orange: 'text-rt-orange',
  yellow: 'text-rt-yellow',
  green: 'text-rt-green',
  blue: 'text-rt-blue',
  purple: 'text-rt-purple',
  red: 'text-rt-red',
};

// The card every chat card starts from: the page's surface in a 2px border.
const PLAIN_CARD = 'border-2 border-border bg-background';

// cardClass is the surface and outline a card with this `color` takes; one
// with no colour ex can read gets the plain bordered card.
export function cardClass(color?: string): string {
  const tint = cardTint(color);
  return tint ? `card-outline ${HUE[tint]}` : PLAIN_CARD;
}

// A quoted message and a link preview are the plain card: they carry no
// status, so no corner mark and no icon.
export const QUOTE_CARD = PLAIN_CARD;
