import { describe, it, expect } from 'vitest';
import { markdownToHast } from './markdown-to-hast';

// SharePoint share links carry `/:x:/` (Excel), `/:w:/` (Word) … segments.
// The fallback parser's earliest-match strategy must keep the whole URL as
// one ex-bare-url — never split it on an emoji-shortcode lookalike. (The
// server extractor has the same regression pinned in markdown_test.go.)

interface Node {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

function collect(node: Node, tag: string, out: Node[] = []): Node[] {
  if (node.tagName === tag) out.push(node);
  for (const child of node.children ?? []) collect(child, tag, out);
  return out;
}

describe('markdownToHast URLs with emoji-like segments', () => {
  it('keeps a SharePoint-style URL whole instead of splitting on :x:', () => {
    const full = 'https://dtolk-my.sharepoint.com/:x:/g/personal/user_example_com/IQA2IkvbBpT7kB?e=Jb5oB7';
    const tree = markdownToHast(`see ${full} now`) as Node;

    const urls = collect(tree, 'ex-bare-url');
    expect(urls).toHaveLength(1);
    expect(urls[0].properties?.['data-href']).toBe(full);
    expect(collect(tree, 'ex-emoji-shortcode')).toHaveLength(0);
  });

  it('still resolves an emoji shortcode outside the URL', () => {
    const tree = markdownToHast(':x: broken build https://ci.example.org/run/1') as Node;
    const emoji = collect(tree, 'ex-emoji-shortcode');
    expect(emoji).toHaveLength(1);
    expect(emoji[0].properties?.['data-name']).toBe('x');
    const urls = collect(tree, 'ex-bare-url');
    expect(urls[0].properties?.['data-href']).toBe('https://ci.example.org/run/1');
  });
});
