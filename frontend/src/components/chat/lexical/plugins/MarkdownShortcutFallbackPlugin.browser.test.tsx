import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
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
});
