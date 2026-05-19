import { describe, it, expect } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
} from 'lexical';
import { ListItemNode, ListNode } from '@lexical/list';
import { QuoteNode } from '@lexical/rich-text';
import { ExListNode } from './nodes/ExListNode';
import { MentionNode } from './nodes/MentionNode';
import { ChannelMentionNode } from './nodes/ChannelMentionNode';
import { $exportMarkdown } from './markdown-export';

function newEditor() {
  return createHeadlessEditor({
    namespace: 'test',
    nodes: [
      ExListNode,
      { replace: ListNode, with: (n: ListNode) => new ExListNode(n.getListType(), n.getStart()), withKlass: ExListNode },
      ListItemNode,
      QuoteNode,
      MentionNode,
      ChannelMentionNode,
    ],
    onError: (e) => { throw e; },
  });
}

describe('markdown export: blank-line preservation', () => {
  // Regression: two Enters in the composer produce paragraph-empty-
  // paragraph in the Lexical tree. The exported markdown must keep a
  // literal blank line between the two paragraphs so the rendered
  // message shows a visible vertical gap; previously the blank line
  // was being stripped on export and the renderer collapsed both
  // paragraphs into adjacent lines.
  it('keeps a blank line between two text paragraphs separated by an empty paragraph', () => {
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const p1 = $createParagraphNode();
      p1.append($createTextNode('first'));
      const pEmpty = $createParagraphNode();
      const p2 = $createParagraphNode();
      p2.append($createTextNode('second'));
      root.append(p1);
      root.append(pEmpty);
      root.append(p2);
    }, { discrete: true });

    let md = '';
    editor.read(() => {
      md = $exportMarkdown();
    });
    // Expected: `first\n\nsecond` — two newlines means: end-of-p1,
    // blank line, start-of-p2. Anything fewer collapses the gap.
    expect(md).toBe('first\n\nsecond');
  });

  // Shift+Enter in the composer inserts a LineBreakNode inline
  // (no new paragraph). Two Shift+Enter presses between text segments
  // produce one paragraph containing [text, LineBreak, LineBreak, text].
  // The exported markdown must keep BOTH "\n" characters — anything
  // less collapses the visible gap once the message renders.
  it('keeps two consecutive Shift+Enter line breaks as two newlines inside one paragraph', () => {
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
    // Expected: `first\n\nsecond` — two newlines between the segments.
    // A single `\n` would join them as one continuous paragraph in the
    // renderer (no visible blank line).
    expect(md).toBe('first\n\nsecond');
  });

  // Same scenario as above but at the *end* of a paragraph followed by
  // another paragraph. Lexical's stock export sometimes elides
  // trailing LineBreaks; we want them preserved so two presses still
  // give one blank line.
  it('keeps Shift+Enter blank line before a following paragraph', () => {
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const p1 = $createParagraphNode();
      p1.append($createTextNode('first'));
      p1.append($createLineBreakNode());
      p1.append($createLineBreakNode());
      const p2 = $createParagraphNode();
      p2.append($createTextNode('second'));
      root.append(p1);
      root.append(p2);
    }, { discrete: true });

    let md = '';
    editor.read(() => {
      md = $exportMarkdown();
    });
    // Two LineBreaks at the end of p1 contribute "\n\n", then the
    // paragraph separator adds "\n\n" before p2 — a robust renderer
    // collapses to "first\n\nsecond" or keeps the literal
    // "first\n\n\n\nsecond". Anything that lands on a single newline
    // ("first\nsecond") is broken and will not render with a gap.
    expect(md).toMatch(/^first(\n\n+)second$/);
  });

  // Lexical's $convertToMarkdownString joins top-level blocks with a
  // single "\n\n" pair regardless of how many empty paragraphs sit
  // between them, so the export always carries exactly one blank line
  // between two text paragraphs even if the user pressed Enter three
  // or more times. That matches the rendered-output expectation
  // (visible gap), even if it doesn't preserve the exact count.
  it('preserves at least one blank line between text paragraphs across multiple empty paragraphs', () => {
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const p1 = $createParagraphNode();
      p1.append($createTextNode('a'));
      const e1 = $createParagraphNode();
      const e2 = $createParagraphNode();
      const p2 = $createParagraphNode();
      p2.append($createTextNode('b'));
      root.append(p1);
      root.append(e1);
      root.append(e2);
      root.append(p2);
    }, { discrete: true });

    let md = '';
    editor.read(() => {
      md = $exportMarkdown();
    });
    expect(md).toMatch(/^a\n\n+b$/);
    // At least one blank line — i.e., 2+ newlines between the two
    // characters, never collapsed to a single newline.
    const newlinesBetween = md.length - 'ab'.length;
    expect(newlinesBetween).toBeGreaterThanOrEqual(2);
  });
});
