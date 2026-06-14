import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { QuoteNode, $createQuoteNode } from '@lexical/rich-text';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  $isParagraphNode,
  $isLineBreakNode,
  KEY_ENTER_COMMAND,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { QuoteContinuationPlugin } from './QuoteContinuationPlugin';

// Browser coverage for the blockquote Enter/Backspace continuation logic
// (was ~46%). A command-plugin harness: seed a quote node + selection, then
// dispatch the key command and assert the resulting tree.

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(): Promise<LexicalEditor> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{ namespace: 'quote-cont', nodes: [QuoteNode], onError: (e) => { throw e; }, theme: {} }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <QuoteContinuationPlugin />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  return editor;
}

function seedQuote(editor: LexicalEditor, fill: (q: QuoteNode) => void) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const quote = $createQuoteNode();
    root.append(quote);
    fill(quote);
  }, { discrete: true });
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

function hasQuote(editor: LexicalEditor): boolean {
  let found = false;
  editor.getEditorState().read(() => {
    for (const c of $getRoot().getChildren()) if (c.getType() === 'quote') found = true;
  });
  return found;
}
function paragraphCount(editor: LexicalEditor): number {
  let n = 0;
  editor.getEditorState().read(() => {
    for (const c of $getRoot().getChildren()) if ($isParagraphNode(c)) n++;
  });
  return n;
}
function quoteLineBreaks(editor: LexicalEditor): number {
  let n = 0;
  editor.getEditorState().read(() => {
    const q = $getRoot().getChildren().find((c) => c.getType() === 'quote') as QuoteNode | undefined;
    if (q) for (const c of q.getChildren()) if ($isLineBreakNode(c)) n++;
  });
  return n;
}
function ev(extra: Record<string, unknown> = {}) {
  return { preventDefault: () => {}, ...extra } as unknown as KeyboardEvent;
}
function flush() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

describe('QuoteContinuationPlugin (browser)', () => {
  it('Enter on a non-empty quote line inserts a soft line break (stays in quote)', async () => {
    const editor = await mount();
    seedQuote(editor, (q) => {
      const t = $createTextNode('hello');
      q.append(t);
      t.select(5, 5);
    });
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    expect(hasQuote(editor)).toBe(true);
    expect(quoteLineBreaks(editor)).toBeGreaterThanOrEqual(1);
  });

  it('Enter on an empty line after content exits to a paragraph and drops the trailing break', async () => {
    const editor = await mount();
    seedQuote(editor, (q) => {
      q.append($createTextNode('a'));
      q.append($createLineBreakNode());
      q.select(2, 2); // caret on the empty line after the line break
    });
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    // Quote keeps its content; a fresh paragraph follows; the trailing break
    // that introduced the blank line is removed.
    expect(hasQuote(editor)).toBe(true);
    expect(paragraphCount(editor)).toBe(1);
    expect(quoteLineBreaks(editor)).toBe(0);
  });

  it('Enter on a fully empty quote replaces it with a paragraph', async () => {
    const editor = await mount();
    seedQuote(editor, (q) => {
      const t = $createTextNode(' ');
      q.append(t);
      t.select(1, 1);
    });
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    expect(hasQuote(editor)).toBe(false);
    expect(paragraphCount(editor)).toBeGreaterThanOrEqual(1);
  });

  it('Enter outside a quote is ignored by the plugin', async () => {
    const editor = await mount();
    seedParagraph(editor, 'hi');
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    expect(hasQuote(editor)).toBe(false);
  });

  it('Enter with a non-collapsed selection is ignored', async () => {
    const editor = await mount();
    seedQuote(editor, (q) => {
      const t = $createTextNode('hello');
      q.append(t);
      t.select(0, 5); // range selection
    });
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    // No soft break inserted (the plugin bailed on the range selection).
    expect(quoteLineBreaks(editor)).toBe(0);
  });

  it('Backspace on an empty quote line exits the quote', async () => {
    const editor = await mount();
    seedQuote(editor, (q) => {
      q.append($createTextNode('a'));
      q.append($createLineBreakNode());
      q.select(2, 2);
    });
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(paragraphCount(editor)).toBe(1);
  });

  it('Backspace on a non-empty quote line does nothing (lets default run)', async () => {
    const editor = await mount();
    seedQuote(editor, (q) => {
      const t = $createTextNode('hello');
      q.append(t);
      t.select(5, 5);
    });
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(hasQuote(editor)).toBe(true);
    expect(paragraphCount(editor)).toBe(0);
  });

  it('Backspace outside a quote is ignored by the plugin', async () => {
    const editor = await mount();
    seedParagraph(editor, 'hi');
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(hasQuote(editor)).toBe(false);
  });
});
