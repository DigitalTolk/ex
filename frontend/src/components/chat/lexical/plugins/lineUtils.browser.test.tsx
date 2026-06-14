import { describe, expect, it } from 'vitest';
import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  $createRangeSelection,
  type RangeSelection,
} from 'lexical';
import { $readCurrentLineText, $currentLineIsEmpty } from './lineUtils';
import { MentionNode, $createMentionNode } from '../nodes/MentionNode';

// lineUtils is excluded from the jsdom gate, so its branch coverage lives in
// the browser gate. These tests drive the helpers with a headless Lexical
// editor and crafted RangeSelections (the `$` helpers need an active editor).

interface Built {
  para: string;
  hello: string;
  blank: string;
  filled: string;
}

function withEditor(run: (keys: Built) => void) {
  const editor = createEditor({ namespace: 'lineutils-test', onError: (e) => { throw e; } });
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    // Paragraph: "hello" <br> "   " <br> "world"
    const para = $createParagraphNode();
    const hello = $createTextNode('hello');
    const blank = $createTextNode('   ');
    const filled = $createTextNode('world');
    para.append(hello, $createLineBreakNode(), blank, $createLineBreakNode(), filled);
    root.append(para);
    run({ para: para.getKey(), hello: hello.getKey(), blank: blank.getKey(), filled: filled.getKey() });
  }, { discrete: true });
  return editor;
}

function selAt(key: string, offset: number, type: 'text' | 'element'): RangeSelection {
  const sel = $createRangeSelection();
  sel.anchor.set(key, offset, type);
  sel.focus.set(key, offset, type);
  return sel;
}

describe('lineUtils (browser)', () => {
  it('reads the current line text up to the caret on a populated line', () => {
    let result = '';
    withEditor((keys) => {
      result = $readCurrentLineText(selAt(keys.hello, 3, 'text'));
    });
    expect(result).toBe('hel');
  });

  it('reads the full second line when the caret is at its end', () => {
    let result = '';
    withEditor((keys) => {
      result = $readCurrentLineText(selAt(keys.filled, 5, 'text'));
    });
    // The walk-back stops at the preceding LineBreakNode, so only "world".
    expect(result).toBe('world');
  });

  it('treats a line with visible characters before the caret as non-empty', () => {
    let empty = true;
    withEditor((keys) => {
      empty = $currentLineIsEmpty(selAt(keys.hello, 5, 'text'));
    });
    expect(empty).toBe(false);
  });

  it('treats a whitespace-only line as empty', () => {
    let empty = false;
    withEditor((keys) => {
      empty = $currentLineIsEmpty(selAt(keys.blank, 3, 'text'));
    });
    expect(empty).toBe(true);
  });

  it('detects a non-empty earlier line segment when walking back', () => {
    let empty = true;
    withEditor((keys) => {
      // Caret in the trailing "world" line but anchored at offset 0 (empty
      // slice) forces the walk-back, which then sees the LineBreak boundary.
      empty = $currentLineIsEmpty(selAt(keys.filled, 0, 'text'));
    });
    expect(empty).toBe(true);
  });

  it('handles an element-node anchor by walking back from the child index', () => {
    let text = 'unset';
    let empty = false;
    withEditor((keys) => {
      // Anchor on the paragraph element at child index 5 (after "world"),
      // exercising the $isElementNode branch of $startWalkingBackFrom.
      text = $readCurrentLineText(selAt(keys.para, 5, 'element'));
      empty = $currentLineIsEmpty(selAt(keys.para, 5, 'element'));
    });
    expect(text).toBe('world');
    expect(empty).toBe(false);
  });

  it('returns an empty string for an element-node anchor at the document start', () => {
    let text = 'unset';
    withEditor((keys) => {
      text = $readCurrentLineText(selAt(keys.para, 0, 'element'));
    });
    expect(text).toBe('');
  });

  it('skips a non-TextNode sibling (decorator mention) while walking back', () => {
    // A paragraph "before " [MentionNode] "after": when reading from a caret in
    // "after", the walk-back hits the MentionNode (not a TextNode), exercising
    // the `if ($isTextNode(prev))` false side in both $readCurrentLineText and
    // $currentLineIsEmpty.
    const editor = createEditor({ namespace: 'lineutils-mention', nodes: [MentionNode], onError: (e) => { throw e; } });
    let text = 'unset';
    let empty = true;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      const before = $createTextNode('before ');
      const mention = $createMentionNode('u-1', 'Alice');
      const after = $createTextNode('after');
      para.append(before, mention, after);
      root.append(para);
      const sel = $createRangeSelection();
      sel.anchor.set(after.getKey(), 5, 'text');
      sel.focus.set(after.getKey(), 5, 'text');
      text = $readCurrentLineText(sel);
      empty = $currentLineIsEmpty(sel);
    }, { discrete: true });
    // The mention contributes no text to the walked line; "before " precedes it.
    expect(text).toContain('after');
    expect(text).toContain('before');
    expect(empty).toBe(false);
  });
});
