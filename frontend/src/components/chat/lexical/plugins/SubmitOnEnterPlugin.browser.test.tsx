import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { QuoteNode, HeadingNode, $createQuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $isLineBreakNode,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { SubmitOnEnterPlugin } from './SubmitOnEnterPlugin';

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(props: { onSubmit?: (md: string) => void; onCancel?: () => void }) {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer
      initialConfig={{ namespace: 'soe', nodes: [QuoteNode, HeadingNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode, LinkNode], onError: (e) => { throw e; }, theme: {} }}
    >
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <SubmitOnEnterPlugin {...props} />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  return editor;
}

function seedParagraph(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const para = $createParagraphNode();
    const t = $createTextNode(text);
    para.append(t);
    root.append(para);
    t.select(text.length, text.length);
  }, { discrete: true });
}

function seedQuote(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const quote = $createQuoteNode();
    const t = $createTextNode(text);
    quote.append(t);
    root.append(quote);
    t.select(text.length, text.length);
  }, { discrete: true });
}

function ev(extra: Record<string, unknown> = {}) {
  return { preventDefault: () => {}, ...extra } as unknown as KeyboardEvent;
}
function flush() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}
function paragraphLineBreaks(editor: LexicalEditor): number {
  let n = 0;
  editor.getEditorState().read(() => {
    for (const c of ($getRoot().getFirstChild() as { getChildren?: () => unknown[] })?.getChildren?.() ?? []) {
      if ($isLineBreakNode(c as never)) n++;
    }
  });
  return n;
}

describe('SubmitOnEnterPlugin (browser)', () => {
  it('Enter at top level submits the markdown', async () => {
    const onSubmit = vi.fn();
    const editor = await mount({ onSubmit });
    seedParagraph(editor, 'hello there');
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('hello there'));
  });

  it('Enter inside a blockquote does NOT submit (structured block)', async () => {
    const onSubmit = vi.fn();
    const editor = await mount({ onSubmit });
    seedQuote(editor, 'quoted line');
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Shift+Enter never submits', async () => {
    const onSubmit = vi.fn();
    const editor = await mount({ onSubmit });
    seedParagraph(editor, 'line');
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev({ shiftKey: true }));
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('without onSubmit, top-level Enter inserts a soft line break', async () => {
    const editor = await mount({});
    seedParagraph(editor, 'line');
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    expect(paragraphLineBreaks(editor)).toBeGreaterThanOrEqual(1);
  });

  it('without onSubmit, Enter inside a blockquote is left to the default (no soft break injected)', async () => {
    const editor = await mount({});
    seedQuote(editor, 'q');
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    // The plugin returned false; it did not inject its own line break into a
    // structured block.
    let lineBreaksInQuote = 0;
    editor.getEditorState().read(() => {
      const quote = $getRoot().getFirstChild() as { getChildren?: () => unknown[] } | null;
      for (const c of (quote?.getChildren?.() ?? [])) if ($isLineBreakNode(c as never)) lineBreaksInQuote++;
    });
    expect(lineBreaksInQuote).toBe(0);
  });

  it('Escape calls onCancel when provided', async () => {
    const onCancel = vi.fn();
    const editor = await mount({ onCancel });
    seedParagraph(editor, 'x');
    editor.dispatchCommand(KEY_ESCAPE_COMMAND, ev());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape is ignored when no onCancel is provided', async () => {
    const editor = await mount({});
    seedParagraph(editor, 'x');
    // Should not throw; the handler returns false.
    editor.dispatchCommand(KEY_ESCAPE_COMMAND, ev());
    await flush();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('x');
  });
});
