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
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { MarkdownChangePlugin } from './MarkdownChangePlugin';

// Browser coverage for the markdown change forwarder. We mount the plugin
// with an onChange spy, mutate the document, and assert the spy receives the
// exported markdown (deduping no-op transactions).

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(onChange?: (md: string) => void): Promise<LexicalEditor> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{ namespace: 'md-change', onError: (e) => { throw e; }, theme: {} }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <MarkdownChangePlugin onChange={onChange} />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return editor;
}

function setText(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const para = $createParagraphNode();
    para.append($createTextNode(text));
    root.append(para);
  }, { discrete: true });
}

function flush() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

describe('MarkdownChangePlugin (browser)', () => {
  it('forwards the exported markdown when the document changes', async () => {
    const onChange = vi.fn();
    const editor = await mount(onChange);
    setText(editor, 'hello world');
    await flush();
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('hello world'));
  });

  it('dedupes identical markdown (no second emit for a no-op update)', async () => {
    const onChange = vi.fn();
    const editor = await mount(onChange);
    setText(editor, 'same');
    await flush();
    const callsAfterFirst = onChange.mock.calls.length;
    // Re-running an update that produces identical markdown hits the
    // `md === lastEmittedRef.current` dedupe branch — no new emit.
    setText(editor, 'same');
    await flush();
    expect(onChange.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not register the listener when no onChange is provided', async () => {
    // The `if (!onChange) return;` guard short-circuits the effect; a document
    // change must not throw.
    const editor = await mount(undefined);
    expect(() => setText(editor, 'noop')).not.toThrow();
  });
});
