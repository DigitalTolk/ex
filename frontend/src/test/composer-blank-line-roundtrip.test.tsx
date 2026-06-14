import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
} from 'lexical';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { ListItemNode, ListNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ExListNode } from '@/components/chat/lexical/nodes/ExListNode';
import { MentionNode } from '@/components/chat/lexical/nodes/MentionNode';
import { ChannelMentionNode } from '@/components/chat/lexical/nodes/ChannelMentionNode';
import { EX_TRANSFORMERS } from '@/components/chat/lexical/transformers';
import { $exportMarkdown } from '@/components/chat/lexical/markdown-export';
import { renderMarkdown } from '@/lib/markdown';

// Full round-trip: a Lexical paragraph that mirrors what the editor
// produces when the user types "first" + Shift+Enter + Shift+Enter +
// "second" must export markdown that renders with a visible blank
// line between the two segments. Three top-level <p> elements is the
// contract — text-paragraph, blank-spacer-paragraph, text-paragraph.
//
// Regression: previously the export emitted "first\nsecond" (single
// newline) which the renderer collapsed into one continuous paragraph
// with no visible gap, even though the composer showed an obvious
// blank line while typing.

function newEditor() {
  return createHeadlessEditor({
    namespace: 'composer-roundtrip',
    nodes: [
      ExListNode,
      { replace: ListNode, with: (n: ListNode) => new ExListNode(n.getListType(), n.getStart()), withKlass: ExListNode },
      ListItemNode,
      QuoteNode,
      HeadingNode,
      CodeNode,
      CodeHighlightNode,
      LinkNode,
      MentionNode,
      ChannelMentionNode,
    ],
    onError: (e) => { throw e; },
  });
}

function roundTrip(input: string): string {
  const editor = newEditor();
  editor.update(() => {
    $convertFromMarkdownString(input, EX_TRANSFORMERS, undefined, true);
  }, { discrete: true });
  let md = '';
  editor.read(() => { md = $exportMarkdown(); });
  return md;
}

function composerBodyForShiftEnterTwice(): string {
  const editor = newEditor();
  editor.update(() => {
    const root = $getRoot();
    const p = $createParagraphNode();
    p.append($createTextNode('first'));
    p.append($createLineBreakNode());
    p.append($createLineBreakNode());
    p.append($createTextNode('second'));
    root.append(p);
  }, { discrete: true });
  let md = '';
  editor.read(() => {
    md = $exportMarkdown();
  });
  return md;
}

describe('composer → render round-trip: blank line preservation', () => {
  it('export preserves both newlines from two Shift+Enter presses', () => {
    expect(composerBodyForShiftEnterTwice()).toBe('first\n\nsecond');
  });

  it('renders three <p> elements when the user typed Shift+Enter twice between segments', () => {
    const body = composerBodyForShiftEnterTwice();
    const { container } = render(<>{renderMarkdown(body)}</>);
    const ps = container.querySelectorAll('p');
    expect(ps.length).toBe(3);
    expect(ps[0].textContent).toBe('first');
    expect(ps[1].textContent?.trim()).toBe('');
    expect(ps[2].textContent).toBe('second');
  });

  it('also works when the user typed Shift+Enter at the end of one paragraph and another Enter started a fresh paragraph', () => {
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const p1 = $createParagraphNode();
      p1.append($createTextNode('first'));
      p1.append($createLineBreakNode());
      const p2 = $createParagraphNode();
      p2.append($createTextNode('second'));
      root.append(p1);
      root.append(p2);
    }, { discrete: true });
    let body = '';
    editor.read(() => {
      body = $exportMarkdown();
    });
    // Trailing LineBreak before a paragraph boundary should still
    // produce a visible gap. At least 2 newlines between the segments.
    expect(body).toMatch(/^first\n\n+second$/);
    const { container } = render(<>{renderMarkdown(body)}</>);
    const ps = container.querySelectorAll('p');
    expect(ps.length).toBeGreaterThanOrEqual(3);
    expect(ps[0].textContent).toBe('first');
    expect(ps[ps.length - 1].textContent).toBe('second');
  });
});

describe('composer → render round-trip: code-fence boundaries add no extra line', () => {
  it('keeps a code block directly adjacent to following inline code (no synthetic blank)', () => {
    // The reported regression: typing a fenced code block immediately before
    // an inline-code line. $convertToMarkdownString inserted a blank line after
    // the closing fence; the renderer drew it as a visible empty row, so the
    // copied/posted message gained a line the user never typed.
    expect(roundTrip('```\nasads\n```\n`asdads`')).toBe('```\nasads\n```\n`asdads`');

    const { container } = render(<>{renderMarkdown('```\nasads\n```\n`asdads`')}</>);
    // No blank spacer paragraph between the <pre> code block and the inline
    // code paragraph.
    expect(container.querySelector('[data-blank="true"]')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe('asads');
    const ps = container.querySelectorAll('p');
    expect(ps.length).toBe(1);
    expect(ps[0].querySelector('code')?.textContent).toBe('asdads');
  });

  it('keeps a code block directly adjacent to a preceding paragraph', () => {
    expect(roundTrip('hello\n```\ncode\n```')).toBe('hello\n```\ncode\n```');
  });

  it('preserves blank lines inside a fenced code block verbatim', () => {
    expect(roundTrip('```\na\n\nb\n```')).toBe('```\na\n\nb\n```');
  });

  it('preserves a deliberate empty-paragraph spacer next to a code block', () => {
    expect(roundTrip('```\ncode\n```\n\n\n\nafter')).toBe('```\ncode\n```\n\n\n\nafter');
  });
});
