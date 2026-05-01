import { describe, it, expect, vi } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { ListItemNode, ListNode, $isListNode } from '@lexical/list';
import { EX_TRANSFORMERS } from '@/components/chat/lexical/transformers';
import { MentionNode } from '@/components/chat/lexical/nodes/MentionNode';
import { ChannelMentionNode } from '@/components/chat/lexical/nodes/ChannelMentionNode';
import { QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode, AutoLinkNode } from '@lexical/link';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function EditorCapture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => onReady(editor), [editor, onReady]);
  return null;
}

async function typeOneChar(editor: LexicalEditor, ch: string) {
  await act(async () => {
    editor.update(
      () => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        sel.insertText(ch);
      },
      { discrete: true },
    );
  });
  // Settle update listeners (MarkdownShortcutPlugin runs in one).
  await act(async () => { await Promise.resolve(); });
}

describe('block restart after exit (lists, quotes)', () => {
  it('typing `1. ` in a paragraph after a list creates a NEW list', async () => {
    let capturedEditor: LexicalEditor | null = null;
    const initialConfig = {
      namespace: 'test',
      nodes: [ListNode, ListItemNode, QuoteNode, CodeNode, CodeHighlightNode, LinkNode, AutoLinkNode, MentionNode, ChannelMentionNode],
      onError: (e: Error) => { throw e; },
    };
    render(
      <Providers>
        <LexicalComposer initialConfig={initialConfig}>
          <RichTextPlugin
            contentEditable={<ContentEditable aria-label="ed" />}
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <ListPlugin />
          <MarkdownShortcutPlugin transformers={EX_TRANSFORMERS} />
          <EditorCapture onReady={(e) => { capturedEditor = e; }} />
        </LexicalComposer>
      </Providers>,
    );
    await waitFor(() => expect(capturedEditor).not.toBeNull());
    const editor = capturedEditor!;

    // Establish a non-null selection (markdown shortcut listener bails
    // when the prevSelection isn't a RangeSelection — i.e., the very
    // first state mutation from initial empty editor).
    await act(async () => {
      editor.update(() => {
        $getRoot().selectEnd();
      }, { discrete: true });
    });
    await act(async () => { await Promise.resolve(); });

    for (const ch of ['1', '.', ' ']) await typeOneChar(editor, ch);
    let n1 = 0;
    editor.getEditorState().read(() => { n1 = $getRoot().getChildren().filter($isListNode).length; });
    expect(n1).toBe(1);

    await typeOneChar(editor, 'a');
    // Press Enter inside list item — go to next item.
    await act(async () => {
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    await act(async () => { await Promise.resolve(); });
    // Press Enter again on empty list item — exit the list.
    await act(async () => {
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    await act(async () => { await Promise.resolve(); });

    for (const ch of ['1', '.', ' ']) await typeOneChar(editor, ch);
    let n2 = 0;
    editor.getEditorState().read(() => {
      n2 = $getRoot().getChildren().filter($isListNode).length;
    });
    // Two distinct lists — the restart succeeded and ListNode's
    // built-in mergeNextSiblingListIfSameType transform did NOT
    // silently merge them.
    expect(n2).toBe(2);
  });

  it('typing `> ` in a paragraph after a quote creates a NEW quote', async () => {
    let capturedEditor: LexicalEditor | null = null;
    const initialConfig = {
      namespace: 'test',
      nodes: [ListNode, ListItemNode, QuoteNode, CodeNode, CodeHighlightNode, LinkNode, AutoLinkNode, MentionNode, ChannelMentionNode],
      onError: (e: Error) => { throw e; },
    };
    render(
      <Providers>
        <LexicalComposer initialConfig={initialConfig}>
          <RichTextPlugin
            contentEditable={<ContentEditable aria-label="ed" />}
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <ListPlugin />
          <MarkdownShortcutPlugin transformers={EX_TRANSFORMERS} />
          <EditorCapture onReady={(e) => { capturedEditor = e; }} />
        </LexicalComposer>
      </Providers>,
    );
    await waitFor(() => expect(capturedEditor).not.toBeNull());
    const editor = capturedEditor!;
    await act(async () => {
      editor.update(() => $getRoot().selectEnd(), { discrete: true });
    });
    await act(async () => { await Promise.resolve(); });

    for (const ch of ['>', ' ']) await typeOneChar(editor, ch);
    await typeOneChar(editor, 'a');
    let q1 = 0;
    editor.getEditorState().read(() => {
      q1 = $getRoot().getChildren().filter((c) => c.getType() === 'quote').length;
    });
    expect(q1).toBe(1);

    // Insert paragraph break to exit quote (Lexical's default).
    await act(async () => {
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    await act(async () => { await Promise.resolve(); });

    for (const ch of ['>', ' ']) await typeOneChar(editor, ch);
    let q2 = 0;
    editor.getEditorState().read(() => {
      q2 = $getRoot().getChildren().filter((c) => c.getType() === 'quote').length;
    });
    expect(q2).toBe(2);
  });
});
