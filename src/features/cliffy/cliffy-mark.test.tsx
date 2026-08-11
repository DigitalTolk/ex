import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CliffyMark } from './cliffy-mark';

describe('CliffyMark', () => {
  it('renders the static mascot from /public with the animated bot left out of it', () => {
    const { container } = render(<CliffyMark />);
    const img = container.querySelector('img')!;
    // The whole point of this component over <CliffBot/> is that it is an
    // <img>: the SVG's internal ids stay scoped to the image, so several of
    // these on one page can't collide.
    expect(img.getAttribute('src')).toBe('/cliffy.svg');
    expect(img.getAttribute('alt')).toBe('Cliffy');
    expect(img.getAttribute('draggable')).toBe('false');
    expect(img.className).toContain('select-none');
  });

  it('merges a caller className onto the base classes', () => {
    const { container } = render(<CliffyMark className="size-8" />);
    const img = container.querySelector('img')!;
    expect(img.className).toContain('size-8');
    expect(img.className).toContain('block');
  });
});
