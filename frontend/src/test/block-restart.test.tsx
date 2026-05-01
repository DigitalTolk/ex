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
  KEY_ARROW_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { ListItemNode, ListNode } from '@lexical/list';
import { QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { EX_TRANSFORMERS } from '@/components/chat/lexical/transformers';
import { MentionNode } from '@/components/chat/lexical/nodes/MentionNode';
import { ChannelMentionNode } from '@/components/chat/lexical/nodes/ChannelMentionNode';
import { ExListNode } from '@/components/chat/lexical/nodes/ExListNode';
import { QuoteContinuationPlugin } from '@/components/chat/lexical/plugins/QuoteContinuationPlugin';
import { CodeBlockExitPlugin } from '@/components/chat/lexical/plugins/CodeBlockExitPlugin';
import { MarkdownShortcutFallbackPlugin } from '@/components/chat/lexical/plugins/MarkdownShortcutFallbackPlugin';

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

const NODES = [
  ExListNode,
  { replace: ListNode, with: (n: ListNode) => new ExListNode(n.getListType(), n.getStart()), withKlass: ExListNode },
  ListItemNode, QuoteNode, CodeNode, CodeHighlightNode,
  LinkNode, AutoLinkNode, MentionNode, ChannelMentionNode,
];

async function setupEditor(): Promise<LexicalEditor> {
  let editor: LexicalEditor | null = null;
  render(
    <Providers>
      <LexicalComposer initialConfig={{ namespace: 'test', nodes: NODES, onError: (e) => { throw e; } }}>
        <RichTextPlugin
          contentEditable={<ContentEditable aria-label="ed" />}
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <ListPlugin />
        <QuoteContinuationPlugin />
        <CodeBlockExitPlugin />
        <MarkdownShortcutPlugin transformers={EX_TRANSFORMERS} />
        <MarkdownShortcutFallbackPlugin />
        <EditorCapture onReady={(e) => { editor = e; }} />
      </LexicalComposer>
    </Providers>,
  );
  await waitFor(() => expect(editor).not.toBeNull());
  // Establish a non-null selection (markdown shortcut listener bails
  // when prevSelection isn't a RangeSelection — true on the very
  // first mutation from an empty initial state).
  await act(async () => {
    editor!.update(() => { $getRoot().selectEnd(); }, { discrete: true });
  });
  await act(async () => { await Promise.resolve(); });
  return editor!;
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
  await act(async () => { await Promise.resolve(); });
}

async function typeString(editor: LexicalEditor, s: string) {
  for (const ch of s) await typeOneChar(editor, ch);
}

async function pressEnter(editor: LexicalEditor) {
  await act(async () => {
    editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent('keydown', { key: 'Enter' }));
  });
  await act(async () => { await Promise.resolve(); });
}

async function pressArrowDown(editor: LexicalEditor) {
  await act(async () => {
    editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  });
  await act(async () => { await Promise.resolve(); });
}

function countByType(editor: LexicalEditor, type: 'list' | 'quote' | 'code'): number {
  // Lists use ExListNode (type 'list-ex'); $isListNode is the
  // production-equivalent check via instanceof.
  let n = 0;
  editor.getEditorState().read(() => {
    n = $getRoot().getChildren().filter((c) => {
      if (type === 'list') return c instanceof ListNode;
      return c.getType() === type;
    }).length;
  });
  return n;
}

describe('block restart after exit (lists, quotes, code blocks)', () => {
  it('typing `1. ` after a list — Enter exit via Lexical default — creates a NEW list', async () => {
    const editor = await setupEditor();
    await typeString(editor, '1. ');
    expect(countByType(editor, 'list')).toBe(1);
    await typeOneChar(editor, 'a');
    // Lexical's default INSERT_PARAGRAPH inside a list item creates a
    // new item; on an empty item it exits via $handleListInsertParagraph.
    await act(async () => { editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined); });
    await act(async () => { await Promise.resolve(); });
    await typeString(editor, '1. ');
    // Two distinct lists — the restart succeeded. Lexical's
    // mergeNextSiblingListIfSameType transform would silently merge
    // adjacent same-type lists; the empty-paragraph separator we
    // keep in transformers/makeListTransformer prevents the merge.
    expect(countByType(editor, 'list')).toBe(2);
  });

  it('typing `> ` after a quote — Enter exit via QuoteContinuationPlugin — creates a NEW quote', async () => {
    const editor = await setupEditor();
    await typeString(editor, '> ');
    expect(countByType(editor, 'quote')).toBe(1);
    await typeOneChar(editor, 'a');
    // First Enter on populated quote line → my plugin inserts a
    // soft LineBreak. Second Enter on the empty line → my plugin's
    // exitQuote runs (current line is empty).
    await pressEnter(editor);
    await pressEnter(editor);
    await typeString(editor, '> ');
    expect(countByType(editor, 'quote')).toBe(2);
  });

  it('after second block creation, the caret IS inside the new list item (Enter would not submit)', async () => {
    // The user-reported symptom: second block visually forms, but Enter
    // submits because SubmitOnEnter walks the parent chain and doesn't
    // find a list item. That implies the selection ended up outside
    // the new list. Pin the selection.anchor down.
    const editor = await setupEditor();
    await typeString(editor, '- ');
    await typeOneChar(editor, 'a');
    await act(async () => { editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined); });
    await act(async () => { await Promise.resolve(); });
    await typeString(editor, '- ');
    expect(countByType(editor, 'list')).toBe(2);

    // Verify the caret is inside the new list item — walk from anchor
    // up the parent chain and confirm a ListItemNode is found. This is
    // exactly what SubmitOnEnter does to decide whether to submit.
    let foundListItem = false;
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      let node: ReturnType<typeof sel.anchor.getNode> | null = sel.anchor.getNode();
      while (node) {
        if (node.getType() === 'listitem') {
          foundListItem = true;
          break;
        }
        node = node.getParent() ?? null;
      }
    });
    expect(foundListItem).toBe(true);
  });

  it('DOM regression: `1. ` after Shift+Enter line breaks renders an <ol>, not plain text', async () => {
    // Mirrors the exact failure mode the user observed: after exiting
    // a list, typing some lines with Shift+Enter (soft break) and
    // then `- ` / `1. ` on a new visual line. Stock Lexical and our
    // earlier fallback both required the trigger to be the FIRST
    // child of the paragraph — a `<br>` ahead of it (which is what
    // every soft break creates) silently disabled the shortcut.
    const editor = await setupEditor();
    // First list — opens the markdown shortcut path.
    await typeString(editor, '- ');
    await typeOneChar(editor, 'x');
    // Exit the list via two paragraph breaks (Lexical's default for
    // empty list items).
    await act(async () => { editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined); });
    await act(async () => { await Promise.resolve(); });
    // Type some text, then a soft line break, then the second
    // shortcut. Soft line break = INSERT_LINE_BREAK_COMMAND, the
    // command Lexical's RichTextPlugin dispatches on Shift+Enter.
    await typeString(editor, 'a');
    await act(async () => {
      editor.update(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        sel.insertLineBreak();
      }, { discrete: true });
    });
    await act(async () => { await Promise.resolve(); });
    await typeString(editor, '- ');

    // Read the actual rendered DOM — the rest of the test asserts
    // exactly what the user pastes from DevTools.
    const html = editor.getRootElement()?.innerHTML ?? '';
    // The new list MUST exist as an <ul>/<ol> after the original
    // paragraph, not as plain text inside the paragraph.
    expect(html).toMatch(/<p[^>]*>.*?a.*?<\/p>\s*<ul/);
  });

  it('DOM regression: `> ` after Shift+Enter line breaks renders a <blockquote>, not plain text', async () => {
    const editor = await setupEditor();
    // Cause the same "trigger sits after a soft break" condition
    // without first exiting another block — the bug is independent of
    // what came before; it just needs a <br> immediately preceding
    // the trigger text node.
    await typeString(editor, 'note');
    await act(async () => {
      editor.update(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        sel.insertLineBreak();
      }, { discrete: true });
    });
    await act(async () => { await Promise.resolve(); });
    await typeString(editor, '> ');
    const html = editor.getRootElement()?.innerHTML ?? '';
    expect(html).toMatch(/<p[^>]*>.*?note.*?<\/p>\s*<blockquote/);
  });

  it('DOM regression: ``` + Enter after Shift+Enter line breaks renders a <code>, not plain text', async () => {
    const editor = await setupEditor();
    await typeString(editor, 'note');
    await act(async () => {
      editor.update(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        sel.insertLineBreak();
      }, { discrete: true });
    });
    await act(async () => { await Promise.resolve(); });
    await typeString(editor, '```');
    await pressEnter(editor);
    const html = editor.getRootElement()?.innerHTML ?? '';
    // Same-shape assertion as the list/quote tests: the original
    // paragraph keeps the prefix content; the code block is a sibling
    // after it (rendered as <code> by @lexical/code).
    expect(html).toMatch(/<p[^>]*>.*?note.*?<\/p>\s*<code/);
  });

  it('typing ``` + Enter after a code block — ArrowDown exit — creates a NEW code block', async () => {
    const editor = await setupEditor();
    // First code block: ``` + Enter triggers Lexical's multiline
    // markdown transformer (runs on KEY_ENTER_COMMAND at LOW).
    await typeString(editor, '```');
    await pressEnter(editor);
    expect(countByType(editor, 'code')).toBe(1);
    await typeOneChar(editor, 'a');
    // Exit via my CodeBlockExitPlugin's ArrowDown handler.
    await pressArrowDown(editor);
    // Now in a paragraph after the code node. Restart with another
    // code block.
    await typeString(editor, '```');
    await pressEnter(editor);
    expect(countByType(editor, 'code')).toBe(2);
  });
});
