import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { CodeNode, CodeHighlightNode, $createCodeNode } from '@lexical/code';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  KEY_ENTER_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  $isParagraphNode,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { CodeBlockExitPlugin } from './CodeBlockExitPlugin';

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(): Promise<LexicalEditor> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{ namespace: 'code-exit', nodes: [CodeNode, CodeHighlightNode], onError: (e) => { throw e; }, theme: {} }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <CodeBlockExitPlugin />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  return editor;
}

// Build a code block with the given lines; caret collapsed at the end of the
// last line. Lines are joined by LineBreakNodes inside one CodeNode.
function seedCode(editor: LexicalEditor, lines: string[]) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const code = $createCodeNode();
    let lastText = $createTextNode(lines[0] ?? '');
    code.append(lastText);
    for (let i = 1; i < lines.length; i++) {
      code.append($createLineBreakNode());
      lastText = $createTextNode(lines[i]);
      code.append(lastText);
    }
    root.append(code);
    const len = (lines.at(-1) ?? '').length;
    lastText.select(len, len);
  }, { discrete: true });
}

function paragraphCount(editor: LexicalEditor): number {
  let n = 0;
  editor.getEditorState().read(() => {
    for (const child of $getRoot().getChildren()) if ($isParagraphNode(child)) n++;
  });
  return n;
}
function hasCodeNode(editor: LexicalEditor): boolean {
  let found = false;
  editor.getEditorState().read(() => {
    for (const child of $getRoot().getChildren()) if (child.getType() === 'code') found = true;
  });
  return found;
}
function ev(extra: Record<string, unknown> = {}) {
  return { preventDefault: () => {}, ...extra } as unknown as KeyboardEvent;
}
function flush() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

describe('CodeBlockExitPlugin (browser)', () => {
  it('Enter on a lone closing fence replaces the code block with a paragraph', async () => {
    const editor = await mount();
    seedCode(editor, ['```']);
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    expect(hasCodeNode(editor)).toBe(false);
    expect(paragraphCount(editor)).toBeGreaterThanOrEqual(1);
  });

  it('Enter on a closing fence after content strips the fence and appends a paragraph', async () => {
    const editor = await mount();
    seedCode(editor, ['const x = 1', '```']);
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    // The code block stays (it still has content) and a paragraph follows it.
    expect(hasCodeNode(editor)).toBe(true);
    expect(paragraphCount(editor)).toBe(1);
  });

  it('Shift+Enter inside a code block does not exit (no paragraph appended)', async () => {
    const editor = await mount();
    seedCode(editor, ['code', '```']);
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev({ shiftKey: true }));
    await flush();
    expect(hasCodeNode(editor)).toBe(true);
    expect(paragraphCount(editor)).toBe(0);
  });

  it('Enter on a non-fence line does not exit the code block', async () => {
    const editor = await mount();
    seedCode(editor, ['still coding']);
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    expect(hasCodeNode(editor)).toBe(true);
    expect(paragraphCount(editor)).toBe(0);
  });

  it('ArrowDown on the last code line exits to a fresh paragraph', async () => {
    const editor = await mount();
    seedCode(editor, ['line one', 'line two']);
    editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, ev());
    await flush();
    expect(paragraphCount(editor)).toBe(1);
  });

  it('ArrowDown is ignored when a later line follows the caret', async () => {
    const editor = await mount();
    // Caret on the FIRST line, with a following line break → stay in block.
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const code = $createCodeNode();
      const firstText = $createTextNode('first');
      code.append(firstText, $createLineBreakNode(), $createTextNode('second'));
      root.append(code);
      firstText.select(5, 5);
    }, { discrete: true });
    editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, ev());
    await flush();
    expect(hasCodeNode(editor)).toBe(true);
    expect(paragraphCount(editor)).toBe(0);
  });

  it('ArrowDown with a modifier key does not exit the code block', async () => {
    const editor = await mount();
    seedCode(editor, ['code']);
    editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, ev({ metaKey: true }));
    await flush();
    expect(hasCodeNode(editor)).toBe(true);
    expect(paragraphCount(editor)).toBe(0);
  });

  it('Enter outside any code block leaves no code node behind', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      const t = $createTextNode('plain');
      para.append(t);
      root.append(para);
      t.select(5, 5);
    }, { discrete: true });
    editor.dispatchCommand(KEY_ENTER_COMMAND, ev());
    await flush();
    // The plugin's findMatchingParent returns null, so it never creates a
    // code block — the document stays code-free.
    expect(hasCodeNode(editor)).toBe(false);
  });
});
