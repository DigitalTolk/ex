import { describe, it, expect } from 'vitest';
import { markdownToHast } from './markdown-to-hast';
import type { HastNode } from '@/types';

// Block structure in the browser's fallback parser (search hits, a message
// while it sends). A message with a fence like "```locals {" crashed the
// window whenever a search listed it: the fence rule refused the line, the
// paragraph rule refused to take a line starting with ```, and the parse
// looped forever, pushing empty paragraphs until the tab ran out of memory.

function children(node: HastNode): HastNode[] {
  return 'children' in node ? (node.children ?? []) : [];
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value;
  return children(node).map(textOf).join('');
}

function tags(node: HastNode): string[] {
  return children(node).map((n) => (n.type === 'element' ? n.tagName : n.type));
}

describe('markdownToHast blocks', () => {
  it('reads a fence whose info string carries more than the language as one code block', () => {
    const body = 'which domains?\n\n```locals {\n  allowed = [\n    "a.example",\n  ]\n}\n```';
    const tree = markdownToHast(body);
    expect(tags(tree)).toEqual(['p', 'p', 'pre']);
    const pre = children(tree)[2];
    expect(pre.type === 'element' && pre.properties?.['data-language']).toBe('locals');
    expect(textOf(pre)).toBe('  allowed = [\n    "a.example",\n  ]\n}');
  });

  it('takes the first word of the info string, lower-cased, as the language', () => {
    const pre = children(markdownToHast('```HCL  {\nx\n```'))[0];
    expect(pre.type === 'element' && pre.properties?.['data-language']).toBe('hcl');
  });

  it('closes a code block only at a bare fence', () => {
    const tree = markdownToHast('```js\nconst a = 1;\n```ts\nconst b = 2;\n```\nafter');
    expect(tags(tree)).toEqual(['pre', 'p']);
    expect(textOf(children(tree)[0])).toBe('const a = 1;\n```ts\nconst b = 2;');
  });

  it('reads lines that only look like a block start as paragraph text', () => {
    // "# " has no title and "```a`b" has a backtick in its info string, so
    // neither opens a block — as a paragraph's first line or a later one.
    expect(tags(markdownToHast('# '))).toEqual(['p']);
    expect(tags(markdownToHast('```a`b'))).toEqual(['p']);
    const tree = markdownToHast('intro\n# \n```a`b\nend');
    expect(tags(tree)).toEqual(['p']);
    expect(textOf(tree)).toContain('intro');
    expect(textOf(tree)).toContain('end');
  });

  it('ends a paragraph where a block takes over', () => {
    const tree = markdownToHast('text\n# Title\nmore\n```sh\nls\n```\n> quoted\n- item\n1. one\n---\n| a |\n|---|');
    expect(tags(tree)).toEqual(['p', 'h1', 'p', 'pre', 'blockquote', 'ul', 'ol', 'hr', 'table']);
  });
});
