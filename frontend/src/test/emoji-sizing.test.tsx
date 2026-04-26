import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from '@/lib/markdown';

describe('Emoji sizing — 14px (h-3.5 w-3.5)', () => {
  it('inline custom emoji image uses h-3.5 w-3.5', () => {
    const { container } = render(
      <>{renderMarkdown(':smile:', { emojiMap: { smile: 'http://x/smile.png' } })}</>,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.className).toContain('h-3.5');
    expect(img?.className).toContain('w-3.5');
  });
});
