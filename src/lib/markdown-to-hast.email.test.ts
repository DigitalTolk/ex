import { describe, it, expect } from 'vitest';
import { markdownToHast } from './markdown-to-hast';

// An email address links in a sent message as it shows in the composer: the
// fallback parser mirrors the server (TestMarkdownRenderer_Email* in
// internal/service/markdown_test.go).

interface Node {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

function hrefs(body: string): unknown[] {
  const out: unknown[] = [];
  const walk = (node: Node) => {
    if (node.tagName === 'ex-bare-url') out.push(node.properties?.['data-href']);
    node.children?.forEach(walk);
  };
  walk(markdownToHast(body) as Node);
  return out;
}

function paragraphText(body: string): string {
  const p = (markdownToHast(body) as Node).children?.[0];
  return (p?.children ?? []).map((n) => (n.tagName === 'ex-bare-url' ? `<${String(n.properties?.['data-value'])}>` : n.value)).join('');
}

describe('markdownToHast email addresses', () => {
  it('links an address as mailto, shown as the address, without the closing period', () => {
    expect(hrefs('mail first.last+ex@mail.example.com.')).toEqual(['mailto:first.last+ex@mail.example.com']);
    expect(paragraphText('mail first.last+ex@mail.example.com.')).toBe('mail <first.last+ex@mail.example.com>.');
  });

  it.each([
    ['user@example.com', ['mailto:user@example.com']],
    ['(user@example.com)', ['mailto:user@example.com']],
    ['to:user@example.com', ['mailto:user@example.com']],
    ['https://user@example.com/x', ['https://user@example.com/x']],
    ['user@localhost', []],
    ['user@example.com_', []],
    ['user@example.co-', []],
    ['`user@example.com`', []],
  ])('%s', (body, want) => {
    expect(hrefs(body)).toEqual(want);
  });

  it('keeps an address ending in "_" as plain text', () => {
    expect(paragraphText('say user@example.com_ now')).toBe('say user@example.com_ now');
  });
});
