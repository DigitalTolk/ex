import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from '@/lib/markdown';

// Body emojis render at 20px so they're legible alongside the 14px
// (text-sm) message text without dwarfing the line.
describe('Emoji sizing — 20px in message body', () => {
  it('inline custom emoji image uses h-[20px] w-[20px]', () => {
    const { container } = render(
      <>{renderMarkdown(':smile:', { emojiMap: { smile: 'http://x/smile.png' } })}</>,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.className).toContain('h-[20px]');
    expect(img?.className).toContain('w-[20px]');
  });

  it('shortcode-resolved unicode emoji inherits the 20px hero size', () => {
    const { container } = render(<>{renderMarkdown(':smile:')}</>);
    const span = container.querySelector('span[title=":smile:"]');
    expect(span).not.toBeNull();
    expect(span?.className).toContain('text-[20px]');
  });
});
