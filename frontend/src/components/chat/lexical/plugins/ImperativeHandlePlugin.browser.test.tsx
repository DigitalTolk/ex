import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { QuoteNode, HeadingNode } from '@lexical/rich-text';
import { $getRoot, $createParagraphNode, $createTextNode, $setSelection, type LexicalEditor } from 'lexical';
import { useEffect } from 'react';
import { ImperativeHandlePlugin, type WysiwygEditorHandle } from './ImperativeHandlePlugin';

// Browser coverage for the imperative toolbar API. We mount the plugin with
// a ref, then drive its methods and assert via editor-state reads — the same
// path MessageInput's toolbar buttons take.

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount() {
  const ref: { current: WysiwygEditorHandle | null } = { current: null };
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer
      initialConfig={{ namespace: 'imp', nodes: [ListNode, ListItemNode, LinkNode, QuoteNode, HeadingNode], onError: (e) => { throw e; }, theme: {} }}
    >
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <ListPlugin />
      <LinkPlugin />
      <ImperativeHandlePlugin imperativeRef={ref} />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  return { ref, editor };
}

function seed(editor: LexicalEditor, textValue: string, selectAll: boolean) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const para = $createParagraphNode();
    const t = $createTextNode(textValue);
    para.append(t);
    root.append(para);
    if (selectAll) t.select(0, textValue.length);
    else t.select(textValue.length, textValue.length);
  }, { discrete: true });
}

function clearDoc(editor: LexicalEditor) {
  editor.update(() => {
    $getRoot().clear();
    $setSelection(null);
  }, { discrete: true });
}

function flush() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

describe('ImperativeHandlePlugin (browser)', () => {
  it('applies marks/blocks and inserts text via the imperative handle', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;
    expect(h).not.toBeNull();

    // Empty document → $ensureSelectionOverAllContent takes the selectEnd path.
    clearDoc(editor);
    h.applyMark('bold');

    // With content → the first/last-descendant selection path + strike mapping.
    seed(editor, 'hello', false);
    h.applyMark('strike');
    h.insertText(' world');
    await flush();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain('world');

    // Block toggles: list, ordered list, quote, then quote again (toggle out).
    seed(editor, 'line', true);
    h.applyBlock('ul');
    seed(editor, 'line', true);
    h.applyBlock('ol');
    seed(editor, 'line', true);
    h.applyBlock('quote');
    h.applyBlock('quote');
    await flush();
  });

  it('round-trips markdown through getMarkdown / setMarkdown', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;
    seed(editor, 'plain text', false);
    expect(typeof h.getMarkdown()).toBe('string');
    h.setMarkdown('## A heading\n\n- item');
    await flush();
    expect(h.getMarkdown().length).toBeGreaterThan(0);
  });

  it('captures and commits a link over the selected text', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;
    seed(editor, 'click me', true);
    const { selectedText } = h.beginLinkEdit();
    expect(selectedText).toBe('click me');
    h.commitLinkEdit('https://example.com', 'click me');
    await flush();
  });

  it('commits a link by inserting display text when there is no prior selection', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;
    clearDoc(editor);
    // beginLinkEdit with no range selection → saved selection is null.
    const res = h.beginLinkEdit();
    expect(res.selectedText).toBe('');
    h.commitLinkEdit('https://example.com', 'Example');
    await flush();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain('Example');
  });

  it('reports active formats and notifies subscribers on change', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;
    const seen: string[][] = [];
    const unsub = h.subscribeActiveFormats((set) => seen.push([...set]));
    // Bold a selection → the update listener pushes a change.
    seed(editor, 'bold me', true);
    h.applyMark('bold');
    await flush();
    const formats = h.getActiveFormats();
    expect(formats instanceof Set).toBe(true);
    // A quote block surfaces the 'quote' active format.
    seed(editor, 'quoted', true);
    h.applyBlock('quote');
    await flush();
    expect(seen.length).toBeGreaterThan(0);
    unsub();
  });

  it('inserts text with no prior selection by falling back to selectEnd', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;
    // No range selection → insertText takes the `$getRoot().selectEnd()` arm.
    clearDoc(editor);
    h.insertText('dropped');
    await flush();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain('dropped');
  });

  it('ensures a selection over element-node descendants when applying a mark', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;
    // Build a list so the first/last descendants are element (list-item)
    // nodes — getPointType then takes its `'element'` side rather than 'text'.
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode('listme'));
      root.append(para);
      para.selectStart();
    }, { discrete: true });
    h.applyBlock('ul');
    await flush();
    // Clear the Lexical selection so applyMark must rebuild it over the list.
    editor.update(() => { $setSelection(null); }, { discrete: true });
    h.applyMark('bold');
    await flush();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain('listme');
  });

  it('reports strikethrough, code, and ordered/unordered list active formats', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;

    // Strikethrough → readActiveFormats hasFormat('strikethrough') add('strike').
    seed(editor, 'strike me', true);
    h.applyMark('strike');
    await flush();
    expect(h.getActiveFormats().has('strike')).toBe(true);

    // Inline code → hasFormat('code') add('code').
    seed(editor, 'code me', true);
    h.applyMark('code');
    await flush();
    expect(h.getActiveFormats().has('code')).toBe(true);

    // Unordered list → getListType() === 'bullet' add('ul').
    seed(editor, 'bullets', true);
    h.applyBlock('ul');
    await flush();
    expect(h.getActiveFormats().has('ul')).toBe(true);

    // Ordered list → getListType() === 'number' add('ol').
    seed(editor, 'numbers', true);
    h.applyBlock('ol');
    await flush();
    expect(h.getActiveFormats().has('ol')).toBe(true);
  });

  it('exposes focus / focusEnd / blur / getElement', async () => {
    const { ref, editor } = await mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const h = ref.current!;
    seed(editor, 'x', false);
    h.focus();
    h.focusEnd();
    h.blur();
    expect(h.getElement()).not.toBeNull();
  });
});
