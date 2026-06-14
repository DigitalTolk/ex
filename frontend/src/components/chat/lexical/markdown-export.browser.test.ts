import { describe, it, expect } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
} from 'lexical';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list';
import { $createQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ExListNode } from './nodes/ExListNode';
import { MentionNode } from './nodes/MentionNode';
import { ChannelMentionNode } from './nodes/ChannelMentionNode';
import { EX_TRANSFORMERS } from './transformers';
import { $exportMarkdown } from './markdown-export';

// Browser-gate coverage for $exportMarkdown / collapseSyntheticBlockGaps
// and the ExListNode value-updater. Only a jsdom test existed before, and
// it's excluded from the browser gate, so these branches read as uncovered
// in the browser view. createHeadlessEditor runs fine under Playwright.

function newEditor() {
  return createHeadlessEditor({
    namespace: 'test',
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

// Import markdown into a fresh editor and re-export it. A lossless round-trip
// is what makes "copy a posted message" reproduce exactly what was written —
// the composer imports a body on edit/paste and exports it on send.
function roundTrip(input: string): string {
  const editor = newEditor();
  editor.update(() => {
    $convertFromMarkdownString(input, EX_TRANSFORMERS, undefined, true);
  }, { discrete: true });
  let out = '';
  editor.read(() => { out = $exportMarkdown(); });
  return out;
}

describe('$exportMarkdown (browser)', () => {
  it('collapses the synthetic gap between two adjacent same-kind lists', () => {
    // Two bullet lists → blockKind(prev)='list' === blockKind(next): the
    // `prevKind !== null && blockKind(next) === prevKind` true side runs
    // and the gap line is dropped (continue).
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const l1 = $createListNode('bullet');
      const i1 = $createListItemNode(); i1.append($createTextNode('a')); l1.append(i1);
      const l2 = $createListNode('bullet');
      const i2 = $createListItemNode(); i2.append($createTextNode('b')); l2.append(i2);
      root.append(l1); root.append(l2);
    }, { discrete: true });
    let md = '';
    editor.read(() => { md = $exportMarkdown(); });
    expect(md).toBe('- a\n- b');
  });

  it('merges adjacent quote blocks (blockKind quote branch)', () => {
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const q1 = $createQuoteNode(); q1.append($createTextNode('one'));
      const q2 = $createQuoteNode(); q2.append($createTextNode('two'));
      root.append(q1); root.append(q2);
    }, { discrete: true });
    let md = '';
    editor.read(() => { md = $exportMarkdown(); });
    expect(md).toBe('> one\n> two');
  });

  it('preserves the gap between different block kinds (list then paragraph)', () => {
    // blockKind(prev)='list', blockKind(next)=null → the collapse guard's
    // `blockKind(next) === prevKind` false side runs; gap kept.
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const list = $createListNode('number');
      const i1 = $createListItemNode(); i1.append($createTextNode('dad')); list.append(i1);
      const i2 = $createListItemNode(); i2.append($createTextNode('adsdas')); list.append(i2);
      const p = $createParagraphNode(); p.append($createTextNode('after'));
      root.append(list); root.append(p);
    }, { discrete: true });
    let md = '';
    editor.read(() => { md = $exportMarkdown(); });
    // The list renumbering (ExListNode $updateChildrenListItemValue) drives
    // `1.`/`2.` and the gap before the paragraph survives.
    expect(md).toBe('1. dad\n2. adsdas\n\nafter');
  });

  it('keeps a literal blank line between two plain paragraphs (prevKind null)', () => {
    // prev is a paragraph (blockKind=null) → the `prevKind !== null` guard's
    // false side runs and the blank line is pushed through.
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const p1 = $createParagraphNode(); p1.append($createTextNode('first'));
      const pEmpty = $createParagraphNode();
      const p2 = $createParagraphNode(); p2.append($createTextNode('second'));
      root.append(p1); root.append(pEmpty); root.append(p2);
    }, { discrete: true });
    let md = '';
    editor.read(() => { md = $exportMarkdown(); });
    expect(md).toBe('first\n\nsecond');
  });

  it('strips the escaped underscore that Lexical adds to emoji shortcodes', () => {
    // Text with an underscore round-trips through exportTextFormat, which
    // escapes it; $exportMarkdown's ESCAPED_UNDERSCORE replace strips it.
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const p = $createParagraphNode(); p.append($createTextNode(':heart_eyes:'));
      root.append(p);
    }, { discrete: true });
    let md = '';
    editor.read(() => { md = $exportMarkdown(); });
    expect(md).toBe(':heart_eyes:');
  });

  it('keeps a leading blank line where there is no previous block (prev = "")', () => {
    // An empty first paragraph means `out` is empty when the blank line is
    // processed → `out.at(-1) ?? ''` takes the `?? ''` side (no prev block),
    // so the gap-collapse guard's prev is falsy and the blank line survives.
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const pEmpty = $createParagraphNode();
      const p = $createParagraphNode(); p.append($createTextNode('body'));
      root.append(pEmpty);
      root.append(p);
    }, { discrete: true });
    let md = '';
    editor.read(() => { md = $exportMarkdown(); });
    expect(md).toContain('body');
  });

  it('scans across multiple blank lines to find the next block (inner loop)', () => {
    // Two adjacent quote blocks separated by extra empty paragraphs: the
    // next-block scan loop walks past more than one blank line before finding
    // the following quote, exercising the `lines[j].trim() !== ''` search.
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const q1 = $createQuoteNode(); q1.append($createTextNode('q1'));
      const e1 = $createParagraphNode();
      const e2 = $createParagraphNode();
      const q2 = $createQuoteNode(); q2.append($createTextNode('q2'));
      root.append(q1); root.append(e1); root.append(e2); root.append(q2);
    }, { discrete: true });
    let md = '';
    editor.read(() => { md = $exportMarkdown(); });
    expect(md).toContain('q1');
    expect(md).toContain('q2');
  });

  it('renumbers ordered-list items after a value change (ExListNode updater)', () => {
    // A list whose start is 5 forces the `child.getValue() !== value`
    // true side for the first item and walks subsequent items, exercising
    // $updateChildrenListItemValue's value++ loop.
    const editor = newEditor();
    editor.update(() => {
      const root = $getRoot();
      const list = $createListNode('number', 5);
      const i1 = $createListItemNode(); i1.append($createTextNode('x')); list.append(i1);
      const i2 = $createListItemNode(); i2.append($createTextNode('y')); list.append(i2);
      root.append(list);
    }, { discrete: true });
    let md = '';
    editor.read(() => { md = $exportMarkdown(); });
    expect(md).toBe('5. x\n6. y');
  });

  // Regression: $convertToMarkdownString inserts a blank line between every
  // pair of blocks, including across a fenced code block. That synthetic blank
  // survived into the stored body and the renderer showed it as a visible
  // empty row — so a code block typed directly next to text gained an extra
  // line, and copying the message reproduced that line (write != see/copy).
  describe('code-fence boundary gaps (round-trip fidelity)', () => {
    it('does not insert a blank line after a code block before inline code', () => {
      // close-fence boundary (fenceRole[p] === 'close')
      expect(roundTrip('```\nasads\n```\n`asdads`')).toBe('```\nasads\n```\n`asdads`');
    });

    it('does not insert a blank line before a code block after a paragraph', () => {
      // open-fence boundary (fenceRole[q] === 'open')
      expect(roundTrip('hello\n```\ncode\n```')).toBe('hello\n```\ncode\n```');
    });

    it('preserves blank lines INSIDE a fenced code block (content role)', () => {
      expect(roundTrip('```\na\n\nb\n```')).toBe('```\na\n\nb\n```');
    });

    it('preserves a deliberate empty-paragraph spacer next to a code block (multi-blank, not isolated)', () => {
      expect(roundTrip('```\ncode\n```\n\n\n\nafter')).toBe('```\ncode\n```\n\n\n\nafter');
    });

    it('still separates two plain paragraphs with a blank line', () => {
      expect(roundTrip('one\n\ntwo')).toBe('one\n\ntwo');
    });
  });
});
