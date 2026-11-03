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

// A tinted card's edge: its own hue, faint, so a pale tint still has a
// shape against the chat.
const EDGE: Record<RichColor, string> = {
  gray: 'border-rt-gray/15',
  brown: 'border-rt-brown/15',
  orange: 'border-rt-orange/15',
  yellow: 'border-rt-yellow/15',
  green: 'border-rt-green/15',
  blue: 'border-rt-blue/15',
  purple: 'border-rt-purple/15',
  red: 'border-rt-red/15',
};

// cardClass is the background and border colour a card with this `color`
// takes.
export function cardClass(color?: string): string {
  const tint = cardTint(color);
  return tint ? `${TINT[tint]} ${EDGE[tint]}` : 'border-border bg-background';
}
