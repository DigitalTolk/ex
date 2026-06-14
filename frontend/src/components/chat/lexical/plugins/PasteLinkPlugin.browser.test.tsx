import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LinkNode, $isLinkNode } from '@lexical/link';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  PASTE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { PasteLinkPlugin } from './PasteLinkPlugin';

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(): Promise<LexicalEditor> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{ namespace: 'paste-link', nodes: [LinkNode], onError: (e) => { throw e; }, theme: {} }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <LinkPlugin />
      <PasteLinkPlugin />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  return editor;
}

function seed(editor: LexicalEditor, text: string, selectAll: boolean) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const para = $createParagraphNode();
    const t = $createTextNode(text);
    para.append(t);
    root.append(para);
    if (selectAll && text.length > 0) {
      t.select(0, text.length);
    } else {
      t.select(text.length, text.length); // collapsed at end
    }
  }, { discrete: true });
}

function pasteEvent(url: string | null) {
  return {
    // Only the plain-text slot carries the payload; other MIME types return ''
    // so Lexical's default paste handler doesn't try to JSON-parse it.
    clipboardData: url === null ? null : { getData: (type: string) => (type === 'text/plain' ? url : '') },
    preventDefault: () => {},
  };
}

function hasLink(editor: LexicalEditor): boolean {
  let found = false;
  editor.getEditorState().read(() => {
    const walk = (node: { getChildren?: () => unknown[] }) => {
      if ($isLinkNode(node as never)) { found = true; return; }
      const kids = node.getChildren?.() ?? [];
      for (const k of kids) walk(k as { getChildren?: () => unknown[] });
    };
    walk($getRoot() as never);
  });
  return found;
}

describe('PasteLinkPlugin (browser)', () => {
  it('wraps a non-collapsed selection in a link when an http URL is pasted', async () => {
    const editor = await mount();
    seed(editor, 'click here', true);
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('https://example.com') as never);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(hasLink(editor)).toBe(true);
  });

  it('ignores a paste with no clipboard data (returns early, no link)', async () => {
    const editor = await mount();
    seed(editor, 'click here', true);
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent(null) as never);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(hasLink(editor)).toBe(false);
  });

  it('ignores a paste whose text is not a single URL', async () => {
    const editor = await mount();
    seed(editor, 'click here', true);
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('just some words') as never);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(hasLink(editor)).toBe(false);
  });

  it('does not link a URL pasted over a collapsed caret', async () => {
    const editor = await mount();
    seed(editor, 'word', false); // collapsed
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent('https://example.com') as never);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(hasLink(editor)).toBe(false);
  });
});
