import { describe, it, expect, vi } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { useEffect } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $createParagraphNode, $createTextNode, type LexicalEditor } from 'lexical';
import { ListItemNode, ListNode } from '@lexical/list';
import { QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { MentionNode } from '@/components/chat/lexical/nodes/MentionNode';
import { ChannelMentionNode } from '@/components/chat/lexical/nodes/ChannelMentionNode';
import { ExListNode } from '@/components/chat/lexical/nodes/ExListNode';
import { MarkdownChangePlugin } from './MarkdownChangePlugin';

function EditorCapture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

const NODES = [
  ExListNode,
  { replace: ListNode, with: (n: ListNode) => new ExListNode(n.getListType(), n.getStart()), withKlass: ExListNode },
  ListItemNode, QuoteNode, CodeNode, CodeHighlightNode,
  LinkNode, AutoLinkNode, MentionNode, ChannelMentionNode,
];

async function setup(onChange?: (md: string) => void): Promise<LexicalEditor> {
  let editor: LexicalEditor | null = null;
  render(
    <LexicalComposer initialConfig={{ namespace: 'mc-test', nodes: NODES, onError: (e) => { throw e; } }}>
      <RichTextPlugin
        contentEditable={<ContentEditable aria-label="ed" />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <ListPlugin />
      <MarkdownChangePlugin onChange={onChange} />
      <EditorCapture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  await waitFor(() => expect(editor).not.toBeNull());
  return editor!;
}

describe('MarkdownChangePlugin', () => {
  it('emits markdown on content change and dedupes identical strings', async () => {
    const onChange = vi.fn();
    const editor = await setup(onChange);

    await act(async () => {
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode('hello world'));
        root.append(p);
      });
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const emitted = onChange.mock.calls.at(-1)![0];
    expect(emitted).toContain('hello world');

    const callsAfterFirst = onChange.mock.calls.length;
    // A second update that produces identical markdown must not re-emit.
    await act(async () => {
      editor.update(() => {
        const root = $getRoot();
        root.getFirstChild()?.markDirty();
      });
    });
    expect(onChange.mock.calls.length).toBe(callsAfterFirst);
  });

  it('registers no listener when onChange is undefined', async () => {
    // Should mount and run without throwing even with no handler.
    const editor = await setup(undefined);
    await act(async () => {
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode('x'));
        root.append(p);
      });
    });
    expect(editor).toBeTruthy();
  });
});
