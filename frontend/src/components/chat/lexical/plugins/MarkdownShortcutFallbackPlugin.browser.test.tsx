import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { HeadingNode, QuoteNode, $createQuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { CodeNode, CodeHighlightNode, $createCodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  $setSelection,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { MarkdownShortcutFallbackPlugin } from './MarkdownShortcutFallbackPlugin';

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(): Promise<LexicalEditor> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{
      namespace: 'md-fallback',
      nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode, LinkNode],
      onError: (e) => { throw e; },
      theme: {},
    }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <MarkdownShortcutFallbackPlugin />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return editor;
}

// Seed a paragraph whose sole text node holds `content`, caret at its end.
function seedParagraph(editor: LexicalEditor, content: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const para = $createParagraphNode();
    const t = $createTextNode(content);
    para.append(t);
    root.append(para);
    t.select(content.length, content.length);
  }, { discrete: true });
}

function firstChildType(editor: LexicalEditor): string {
  let type = '';
  editor.getEditorState().read(() => {
    type = $getRoot().getFirstChild()?.getType() ?? '';
  });
  return type;
}

function pasteEvent(text: string) {
  return {
    clipboardData: { getData: (t: string) => (t === 'text/plain' ? text : '') },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
}

async function flush() {
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
}

describe('MarkdownShortcutFallbackPlugin (browser)', () => {
  it('leaves "# " as a paragraph because the heading transformer is stripped', async () => {
    // EX_TRANSFORMERS deliberately drops the heading/list element transformers,
    // so "# " matches none of them and the line stays plain text.
    const editor = await mount();
    seedParagraph(editor, '# ');
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('converts "> " into a quote block', async () => {
    const editor = await mount();
    seedParagraph(editor, '> ');
    await flush();
    expect(firstChildType(editor)).toBe('quote');
  });

  it('leaves ordinary text untouched (no trailing space, no match)', async () => {
    const editor = await mount();
    seedParagraph(editor, 'just text');
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('converts an opening code fence into a code block on Enter', async () => {
    const editor = await mount();
    seedParagraph(editor, '```');
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    expect(firstChildType(editor)).toBe('code');
  });

  it('does not convert on Enter when the line is not an opening fence', async () => {
    const editor = await mount();
    seedParagraph(editor, 'hello');
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('pastes fenced code into an empty paragraph as a code block (replace)', async () => {
    const editor = await mount();
    seedParagraph(editor, '');
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('```js\nconst x = 1\n```'));
    await flush();
    expect(firstChildType(editor)).toBe('code');
  });

  it('pastes fenced code after existing text (insertAfter)', async () => {
    const editor = await mount();
    seedParagraph(editor, 'note:');
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('```\nplain\n```'));
    await flush();
    let hasCode = false;
    editor.getEditorState().read(() => {
      for (const c of $getRoot().getChildren()) if (c.getType() === 'code') hasCode = true;
    });
    expect(hasCode).toBe(true);
  });

  it('ignores a paste that is not fenced code', async () => {
    const editor = await mount();
    seedParagraph(editor, '');
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('just some pasted text'));
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  // Seed a paragraph with `before`, a line break, then `line2` (caret at end of
  // line2) — the second-line transforms exercise the afterLineBreak split path.
  function seedSecondLine(editor: LexicalEditor, before: string, line2: string) {
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode(before));
      para.append($createLineBreakNode());
      const t = $createTextNode(line2);
      para.append(t);
      root.append(para);
      t.select(line2.length, line2.length);
    }, { discrete: true });
  }

  function hasNodeType(editor: LexicalEditor, type: string): boolean {
    let found = false;
    editor.getEditorState().read(() => {
      const walk = (n: { getType: () => string; getChildren?: () => unknown[] }) => {
        if (n.getType() === type) { found = true; return; }
        for (const c of (n.getChildren?.() ?? [])) walk(c as typeof n);
      };
      walk($getRoot() as never);
    });
    return found;
  }

  it('converts "> " after a line break into a quote (afterLineBreak split path)', async () => {
    const editor = await mount();
    seedSecondLine(editor, 'intro', '> ');
    await flush();
    expect(hasNodeType(editor, 'quote')).toBe(true);
  });

  it('converts an opening fence after a line break into a code block on Enter', async () => {
    const editor = await mount();
    seedSecondLine(editor, 'intro', '```js');
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    expect(hasNodeType(editor, 'code')).toBe(true);
  });

  it('does not convert on Enter when the caret is not at the end of the line', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      const t = $createTextNode('```');
      para.append(t);
      root.append(para);
      t.select(1, 1); // caret mid-text, not at the end
    }, { discrete: true });
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('does not convert on Enter when the selection is a non-collapsed range', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      const t = $createTextNode('```');
      para.append(t);
      root.append(para);
      t.select(0, 3); // a range, not a collapsed caret
    }, { discrete: true });
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('pastes multi-line fenced code preserving blank lines', async () => {
    const editor = await mount();
    seedParagraph(editor, '');
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('```\nline1\n\nline3\n```'));
    await flush();
    expect(firstChildType(editor)).toBe('code');
    // The code node retained all three logical lines (blank line included).
    expect(editor.getEditorState().read(() => $getRoot().getFirstChild()?.getTextContent() ?? '')).toContain('line3');
  });

  it('pastes fenced code with no active range selection (selectEnd fallback)', async () => {
    // Clear the Lexical selection before the paste so the handler's
    // `$isRangeSelection(currentSelection) ? ... : $getRoot().selectEnd()`
    // takes its right-hand selectEnd arm.
    const editor = await mount();
    seedParagraph(editor, '');
    editor.update(() => { $setSelection(null); }, { discrete: true });
    await flush();
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('```\nselected-end\n```'));
    await flush();
    let hasCode = false;
    editor.getEditorState().read(() => {
      for (const c of $getRoot().getChildren()) if (c.getType() === 'code') hasCode = true;
    });
    expect(hasCode).toBe(true);
  });

  it('ignores a paste event with no clipboard data', async () => {
    const editor = await mount();
    seedParagraph(editor, '');
    editor.dispatchCommand(PASTE_COMMAND, { clipboardData: null, preventDefault: () => {} } as unknown as ClipboardEvent);
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('does not transform a trigger inside a nested paragraph (grandparent not root)', async () => {
    // The "> " text lives in a paragraph nested in a quote, so the transform's
    // `$isRootOrShadowRoot(grandparent)` guard fails and nothing converts.
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const quote = $createQuoteNode();
      const para = $createParagraphNode();
      const t = $createTextNode('> ');
      para.append(t);
      quote.append(para);
      root.append(quote);
      t.select(2, 2);
    }, { discrete: true });
    await flush();
    // The outer quote is still a quote, but no NEW quote was produced from "> ".
    expect(firstChildType(editor)).toBe('quote');
  });

  it('does not transform a trigger that is neither the first child nor after a break', async () => {
    // A leading text node, then the "> " node — the trigger is the SECOND child
    // with no preceding line break, so `!isFirstChild && !afterLineBreak` bails.
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode('lead'));
      const t = $createTextNode('> ');
      para.append(t);
      root.append(para);
      t.select(2, 2);
    }, { discrete: true });
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('does not transform when the trigger text has trailing content beyond the match', async () => {
    // "> more " matches the quote regExp at index 0 but `match[0].length !==
    // textContent.length`, so the conservative continue-skip keeps it plain.
    const editor = await mount();
    seedParagraph(editor, '> more ');
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('does not convert on Enter when the caret is in an element node (no text anchor)', async () => {
    // Empty paragraph: the anchor is the paragraph element, so the Enter
    // handler's `!$isTextNode(anchorNode)` true side returns false.
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      root.append(para);
      para.selectEnd();
    }, { discrete: true });
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('does not convert on Enter when the fence text is not inside a paragraph', async () => {
    // Put the fence text directly in a quote node so the Enter handler's
    // `!$isParagraphNode(paragraph)` true side returns false.
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const quote = $createQuoteNode();
      const t = $createTextNode('```');
      quote.append(t);
      root.append(quote);
      t.select(3, 3);
    }, { discrete: true });
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    expect(firstChildType(editor)).toBe('quote');
  });

  it('does not convert on Enter when the fence is a nested paragraph (grandparent not root)', async () => {
    // Fence text in a paragraph nested under a quote → the Enter handler's
    // grandparent root check fails.
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const quote = $createQuoteNode();
      const para = $createParagraphNode();
      const t = $createTextNode('```');
      para.append(t);
      quote.append(para);
      root.append(quote);
      t.select(3, 3);
    }, { discrete: true });
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    // No top-level code block was created.
    expect(firstChildType(editor)).toBe('quote');
  });

  it('does not convert on Enter when the fence is neither first child nor after a break', async () => {
    // A leading text node before the fence in the same paragraph → the Enter
    // handler's `!isFirstChild && !afterLineBreak` bails.
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode('x'));
      const t = $createTextNode('```');
      para.append(t);
      root.append(para);
      t.select(3, 3);
    }, { discrete: true });
    editor.dispatchCommand(KEY_ENTER_COMMAND, { preventDefault: () => {} } as unknown as KeyboardEvent);
    await flush();
    expect(firstChildType(editor)).toBe('paragraph');
  });

  it('ignores a fenced-code paste when the caret is not inside a paragraph', async () => {
    // Caret inside a code node: the paste handler's `paragraph` resolution
    // yields a non-paragraph, so `!$isParagraphNode(paragraph)` returns false.
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const code = $createCodeNode();
      const t = $createTextNode('existing');
      code.append(t);
      root.append(code);
      t.select(8, 8);
    }, { discrete: true });
    await flush();
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('```\nignored\n```'));
    await flush();
    // The original single code node is unchanged — no extra block was inserted.
    let codeCount = 0;
    editor.getEditorState().read(() => {
      for (const c of $getRoot().getChildren()) if (c.getType() === 'code') codeCount++;
    });
    expect(codeCount).toBe(1);
  });
});
