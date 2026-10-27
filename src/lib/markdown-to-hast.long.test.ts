import { describe, it, expect } from 'vitest';
import { markdownToHast } from './markdown-to-hast';
import type { HastNode } from '@/types';

// Search hits are parsed in the browser from their raw body (the chat view
// gets a server-rendered tree). A long imported message — a pasted log or
// JSON blob — froze the window: each inline token re-searched and re-copied
// the whole rest of the text, so the cost grew with the square of its
// length, and it ran again on every keystroke while results stayed on screen.

function tagged(node: HastNode, tagName: string): HastNode[] {
  const found: HastNode[] = [];
  const walk = (n: HastNode) => {
    if (n.type === 'element' && n.tagName === tagName) found.push(n);
    if ('children' in n) for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return found;
}

describe('markdownToHast on long messages', () => {
  it('parses a long, token-dense message in time proportional to its length', () => {
    // ~300 KB of JSON, URLs and hashtags on one line: seconds before.
    const body = JSON.stringify(Array.from({ length: 6000 }, (_, i) => ({ id: i, url: `https://x.io/${i}`, tag: `#t${i}` })));
    const t0 = performance.now();
    const tree = markdownToHast(body);
    const ms = performance.now() - t0;
    expect(tagged(tree, 'ex-bare-url')).toHaveLength(6000);
    expect(ms).toBeLessThan(1000);
  });

  it('keeps every token of a message with more than 10,000 of them', () => {
    // It used to stop after 10,000 and drop the rest of the text.
    const body = Array.from({ length: 12000 }, (_, i) => `\`c${i}\``).join(' ') + ' the end';
    const tree = markdownToHast(body);
    const codes = tagged(tree, 'code');
    expect(codes).toHaveLength(12000);
    expect(JSON.stringify(tree)).toContain('the end');
  });
});
