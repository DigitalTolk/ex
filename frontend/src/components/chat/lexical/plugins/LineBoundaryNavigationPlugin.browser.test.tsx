import { describe, expect, it } from 'vitest';
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
  $createLineBreakNode,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { LineBoundaryNavigationPlugin } from './LineBoundaryNavigationPlugin';

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(): Promise<{ editor: LexicalEditor; root: HTMLElement }> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{ namespace: 'line-nav', onError: (e) => { throw e; }, theme: {} }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <LineBoundaryNavigationPlugin />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  // Wait for the plugin's effect to attach its keydown listener.
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return { editor, root: editor.getRootElement()! };
}

function seed(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const para = $createParagraphNode();
    if (text) para.append($createTextNode(text));
    root.append(para);
    para.selectEnd();
  }, { discrete: true });
}

function key(root: HTMLElement, init: KeyboardEventInit) {
  root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function text(editor: LexicalEditor): string {
  let t = '';
  editor.getEditorState().read(() => { t = $getRoot().getTextContent(); });
  return t;
}

async function flush() {
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
}

describe('LineBoundaryNavigationPlugin (browser)', () => {
  it('Cmd+ArrowLeft then a character inserts that character at the editable start', async () => {
    const { editor, root } = await mount();
    seed(editor, 'hello');
    key(root, { key: 'ArrowLeft', metaKey: true });
    key(root, { key: 'x' });
    await flush();
    expect(text(editor)).toBe('xhello');
  });

  it('Cmd+ArrowLeft then a space inserts a leading space', async () => {
    const { editor, root } = await mount();
    seed(editor, 'hi');
    key(root, { key: 'ArrowLeft', metaKey: true });
    key(root, { key: ' ' });
    await flush();
    expect(text(editor)).toBe(' hi');
  });

  it('keeps the forced-start latch across a modifier key, then inserts', async () => {
    const { editor, root } = await mount();
    seed(editor, 'abc');
    key(root, { key: 'ArrowLeft', metaKey: true });
    key(root, { key: 'Shift' }); // modifier → latch persists
    key(root, { key: 'z' });
    await flush();
    expect(text(editor)).toBe('zabc');
  });

  it('clears the latch on a non-plain navigation key without inserting', async () => {
    const { editor, root } = await mount();
    seed(editor, 'abc');
    key(root, { key: 'ArrowLeft', metaKey: true });
    key(root, { key: 'ArrowRight' }); // not plain, not modifier → reset
    key(root, { key: 'q' });
    await flush();
    // The latch was cleared, so 'q' was NOT force-inserted at the start.
    expect(text(editor)).toBe('abc');
  });

  it('ignores Cmd+Shift+ArrowLeft (selection-extend chord)', async () => {
    const { editor, root } = await mount();
    seed(editor, 'abc');
    key(root, { key: 'ArrowLeft', metaKey: true, shiftKey: true });
    key(root, { key: 'k' });
    await flush();
    expect(text(editor)).toBe('abc');
  });

  it('resets the latch on mousedown', async () => {
    const { editor, root } = await mount();
    seed(editor, 'abc');
    key(root, { key: 'ArrowLeft', metaKey: true });
    root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    key(root, { key: 'k' });
    await flush();
    expect(text(editor)).toBe('abc');
  });

  it('inserts at the start of an initially empty paragraph', async () => {
    const { editor, root } = await mount();
    seed(editor, '');
    key(root, { key: 'ArrowLeft', metaKey: true });
    key(root, { key: 'q' });
    await flush();
    expect(text(editor)).toBe('q');
  });

  it('inserts at the start when the first block is a non-element (empty root)', async () => {
    // Clear the root to NO children: getFirstChild() is null, so both
    // selectEditableStart and insertAtEditableStart take their
    // `!$isElementNode(firstBlock)` true side (root.selectStart()).
    const { editor, root } = await mount();
    editor.update(() => {
      const r = $getRoot();
      r.clear();
    }, { discrete: true });
    await flush();
    key(root, { key: 'ArrowLeft', metaKey: true });
    key(root, { key: 'z' });
    await flush();
    expect(text(editor)).toBe('z');
  });

  it('inserts before a non-text first child (leading line break) at the editable start', async () => {
    // First child of the paragraph is a LineBreakNode, not a TextNode: both
    // selectEditableStart and insertAtEditableStart take the `if (firstChild)`
    // non-text branch (insertBefore a prefix text node).
    const { editor, root } = await mount();
    editor.update(() => {
      const r = $getRoot();
      r.clear();
      const para = $createParagraphNode();
      para.append($createLineBreakNode());
      para.append($createTextNode('tail'));
      r.append(para);
      para.selectEnd();
    }, { discrete: true });
    await flush();
    key(root, { key: 'ArrowLeft', metaKey: true });
    key(root, { key: 'w' });
    await flush();
    expect(text(editor)).toContain('w');
    // The inserted character lands before the soft-break-led content.
    expect(text(editor).startsWith('w')).toBe(true);
  });
});
