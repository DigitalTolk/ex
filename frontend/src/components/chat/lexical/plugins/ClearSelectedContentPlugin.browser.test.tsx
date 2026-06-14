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
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { MentionNode, $createMentionNode } from '../nodes/MentionNode';
import { ChannelMentionNode, $createChannelMentionNode } from '../nodes/ChannelMentionNode';
import { ClearSelectedContentPlugin } from './ClearSelectedContentPlugin';

// Browser coverage for the select-all-clear + adjacent-mention-delete logic.
// This plugin reads the REAL DOM selection (window.getSelection), so it only
// works in the browser gate where we can place real ranges over the editor.

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(): Promise<LexicalEditor> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{ namespace: 'clear-sel', nodes: [MentionNode, ChannelMentionNode], onError: (e) => { throw e; }, theme: {} }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <ClearSelectedContentPlugin />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  return editor;
}

function ev() {
  return { preventDefault: () => {} } as unknown as KeyboardEvent;
}
function flush() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}
function editorText(editor: LexicalEditor): string {
  let out = '';
  editor.getEditorState().read(() => { out = $getRoot().getTextContent(); });
  return out;
}

describe('ClearSelectedContentPlugin (browser)', () => {
  it('Backspace with the whole editor selected clears it to one empty paragraph', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode('hello world'));
      root.append(para);
    }, { discrete: true });
    await flush();
    // Put a REAL DOM selection over all the editor's content.
    const root = editor.getRootElement()!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.selectAllChildren(root);
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(editorText(editor)).toBe('');
  });

  it('Delete with the whole editor selected also clears it', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode('text to wipe'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.selectAllChildren(root);
    editor.dispatchCommand(KEY_DELETE_COMMAND, ev());
    await flush();
    expect(editorText(editor)).toBe('');
  });

  it('Backspace just after a mention removes the mention node', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createMentionNode('u-1', 'Alice'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    const mentionEl = root.querySelector('[data-user-id]') as HTMLElement;
    expect(mentionEl).not.toBeNull();
    // Collapsed caret immediately AFTER the mention span.
    const range = document.createRange();
    range.setStartAfter(mentionEl);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(root.querySelector('[data-user-id]')).toBeNull();
  });

  it('Backspace just after a channel mention removes the channel mention node', async () => {
    // Exercises the `$isChannelMentionNode(node)` arm of the removal guard —
    // the user-mention tests only hit the `$isMentionNode` side.
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createChannelMentionNode('c-1', 'general'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    const chEl = root.querySelector('[data-channel-id]') as HTMLElement;
    expect(chEl).not.toBeNull();
    const range = document.createRange();
    range.setStartAfter(chEl);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(root.querySelector('[data-channel-id]')).toBeNull();
  });

  it('Delete just before a mention removes the mention node', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createMentionNode('u-2', 'Bob'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    const mentionEl = root.querySelector('[data-user-id]') as HTMLElement;
    const range = document.createRange();
    range.setStartBefore(mentionEl);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchCommand(KEY_DELETE_COMMAND, ev());
    await flush();
    expect(root.querySelector('[data-user-id]')).toBeNull();
  });

  it('Backspace with a collapsed caret in plain text is left to the default handler', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode('keep me'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    // Lexical wraps text in a <span>, so walk to the actual text node.
    const textNode = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // The plugin returns false (no full-select, no adjacent mention) and lets
    // the default backspace run — so the editor is NOT wiped to empty (the
    // default handler just deletes the single char before the caret).
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    const after = editorText(editor);
    expect(after).not.toBe('');
    expect(after).toContain('me');
  });

  it('Backspace at the start of a text node after a mention removes the mention', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createMentionNode('u-9', 'Carol'));
      para.append($createTextNode('abc'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    // Caret at offset 0 of the text node "abc" → the plugin walks back from the
    // text node (and its wrapper span) to find the preceding mention element.
    const textNode = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent === 'abc' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    }).nextNode()!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(root.querySelector('[data-user-id]')).toBeNull();
  });

  it('clears via boundary-point comparison when the selection string differs from textContent', async () => {
    // A document containing a mention: the mention's DOM text differs from
    // `selection.toString()`, so `domSelectionCoversEditor` falls through the
    // `toString() === textContent` equality (its false side) to the
    // compareBoundaryPoints range check (both START_TO_START and END_TO_END).
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode('hi '));
      para.append($createMentionNode('u-77', 'Zoe'));
      para.append($createTextNode(' bye'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    // Span the whole editable region with an explicit range so the boundary
    // points exactly enclose the editor contents.
    const range = document.createRange();
    range.selectNodeContents(root);
    sel.addRange(range);
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(editorText(editor)).toBe('');
  });

  it('Delete just before a channel mention (element-node forward walk) removes it', async () => {
    // Caret expressed as an element-node container with an offset, deleting
    // forward → adjacentMentionElement takes its ELEMENT_NODE + forward arm
    // (`container.childNodes[range.startOffset]`).
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createChannelMentionNode('c-5', 'random'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    const chEl = root.querySelector('[data-channel-id]') as HTMLElement;
    const paraEl = chEl.parentElement!;
    const range = document.createRange();
    // Element-node container, offset 0 → forward walk picks childNodes[0].
    range.setStart(paraEl, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchCommand(KEY_DELETE_COMMAND, ev());
    await flush();
    expect(root.querySelector('[data-channel-id]')).toBeNull();
  });

  it('Backspace just after a mention via an element-node container removes it', async () => {
    // Element-node container with offset 1, deleting backward →
    // adjacentMentionElement ELEMENT_NODE + backward arm
    // (`container.childNodes[range.startOffset - 1]`).
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createMentionNode('u-88', 'Yan'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    const mentionEl = root.querySelector('[data-user-id]') as HTMLElement;
    const paraEl = mentionEl.parentElement!;
    const range = document.createRange();
    range.setStart(paraEl, 1); // after the mention child
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchCommand(KEY_BACKSPACE_COMMAND, ev());
    await flush();
    expect(root.querySelector('[data-user-id]')).toBeNull();
  });

  it('Delete at the end of a text node before a mention removes the mention', async () => {
    const editor = await mount();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      para.append($createTextNode('abc'));
      para.append($createMentionNode('u-10', 'Dave'));
      root.append(para);
    }, { discrete: true });
    await flush();
    const root = editor.getRootElement()!;
    // Caret at the end of "abc" → forward walk finds the following mention.
    const textNode = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent === 'abc' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    }).nextNode()!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchCommand(KEY_DELETE_COMMAND, ev());
    await flush();
    expect(root.querySelector('[data-user-id]')).toBeNull();
  });
});
