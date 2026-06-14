import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  KEY_ARROW_UP_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { EditLastOnArrowUpPlugin } from './EditLastOnArrowUpPlugin';

// Browser coverage for the "ArrowUp in an empty composer edits the last
// message" plugin. We mount the plugin with a callback, seed the document,
// then dispatch KEY_ARROW_UP_COMMAND and assert whether the callback fired
// and whether the event was claimed.

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(onArrowUpEmpty?: () => boolean): Promise<LexicalEditor> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{ namespace: 'edit-last', onError: (e) => { throw e; }, theme: {} }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <EditLastOnArrowUpPlugin onArrowUpEmpty={onArrowUpEmpty} />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return editor;
}

function seedEmpty(editor: LexicalEditor) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    root.append($createParagraphNode());
  }, { discrete: true });
}

function seedText(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const para = $createParagraphNode();
    para.append($createTextNode(text));
    root.append(para);
  }, { discrete: true });
}

function ev() {
  return { preventDefault: vi.fn() } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function flush() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

describe('EditLastOnArrowUpPlugin (browser)', () => {
  it('invokes the callback and claims the event when the editor is empty', async () => {
    const onArrowUpEmpty = vi.fn(() => true);
    const editor = await mount(onArrowUpEmpty);
    seedEmpty(editor);
    const e = ev();
    const claimed = editor.dispatchCommand(KEY_ARROW_UP_COMMAND, e);
    await flush();
    expect(onArrowUpEmpty).toHaveBeenCalledTimes(1);
    expect(claimed).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('does not claim the event when the editor has content (isEmpty false)', async () => {
    const onArrowUpEmpty = vi.fn(() => true);
    const editor = await mount(onArrowUpEmpty);
    seedText(editor, 'draft in progress');
    const claimed = editor.dispatchCommand(KEY_ARROW_UP_COMMAND, ev());
    await flush();
    // `!isEmpty` true side returns false; the callback is never consulted.
    expect(onArrowUpEmpty).not.toHaveBeenCalled();
    expect(claimed).toBe(false);
  });

  it('does not claim the event when the callback declines (returns false)', async () => {
    const onArrowUpEmpty = vi.fn(() => false);
    const editor = await mount(onArrowUpEmpty);
    seedEmpty(editor);
    const e = ev();
    const claimed = editor.dispatchCommand(KEY_ARROW_UP_COMMAND, e);
    await flush();
    expect(onArrowUpEmpty).toHaveBeenCalledTimes(1);
    expect(claimed).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('does not register the command when no callback is provided', async () => {
    // Mounting without onArrowUpEmpty hits the early-return guard; ArrowUp is a
    // no-op handled by Lexical's defaults.
    const editor = await mount(undefined);
    seedEmpty(editor);
    expect(() => editor.dispatchCommand(KEY_ARROW_UP_COMMAND, ev())).not.toThrow();
  });
});
