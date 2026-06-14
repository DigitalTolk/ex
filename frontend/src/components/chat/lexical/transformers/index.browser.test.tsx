import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { LinkNode } from '@lexical/link';
import { $getRoot, $createParagraphNode, $createTextNode, $getNodeByKey, type LexicalEditor } from 'lexical';
import { useEffect } from 'react';
import { MentionNode, $createMentionNode } from '../nodes/MentionNode';
import { ChannelMentionNode, $createChannelMentionNode } from '../nodes/ChannelMentionNode';
import { MENTION_TRANSFORMER, CHANNEL_MENTION_TRANSFORMER, EX_TRANSFORMERS } from './index';

// Browser coverage for the custom markdown transformers — the mention/channel
// export functions (node → markdown string / null) and the list-import path.

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount() {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer
      initialConfig={{
        namespace: 'tx',
        nodes: [MentionNode, ChannelMentionNode, ListNode, ListItemNode, HeadingNode, QuoteNode, LinkNode],
        onError: (e) => { throw e; },
        theme: {},
      }}
    >
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  return editor;
}

describe('lexical custom transformers (browser)', () => {
  it('MENTION_TRANSFORMER.export emits markdown for a mention and null otherwise', async () => {
    const editor = await mount();
    const keys: { mention: string; para: string } = { mention: '', para: '' };
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      const mention = $createMentionNode('u-1', 'Alice');
      para.append(mention);
      root.append(para);
      keys.mention = mention.getKey();
      keys.para = para.getKey();
    }, { discrete: true });
    editor.getEditorState().read(() => {
      expect(MENTION_TRANSFORMER.export!($getNodeByKey(keys.mention)!, () => '', () => '')).toBe('@[u-1|Alice]');
      expect(MENTION_TRANSFORMER.export!($getNodeByKey(keys.para)!, () => '', () => '')).toBeNull();
    });
  });

  it('CHANNEL_MENTION_TRANSFORMER.export emits markdown for a channel mention and null otherwise', async () => {
    const editor = await mount();
    const keys: { chan: string; para: string } = { chan: '', para: '' };
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      const chan = $createChannelMentionNode('c-1', 'general');
      para.append(chan);
      root.append(para);
      keys.chan = chan.getKey();
      keys.para = para.getKey();
    }, { discrete: true });
    editor.getEditorState().read(() => {
      expect(CHANNEL_MENTION_TRANSFORMER.export!($getNodeByKey(keys.chan)!, () => '', () => '')).toBe('~[c-1|general]');
      expect(CHANNEL_MENTION_TRANSFORMER.export!($getNodeByKey(keys.para)!, () => '', () => '')).toBeNull();
    });
  });

  it('imports a markdown ordered list through the stock import path', async () => {
    const editor = await mount();
    editor.update(() => {
      $convertFromMarkdownString('1. first\n2. second', EX_TRANSFORMERS, undefined, true);
    }, { discrete: true });
    let hasList = false;
    editor.getEditorState().read(() => {
      hasList = $getRoot().getChildren().some((c) => c.getType() === 'list');
    });
    expect(hasList).toBe(true);
  });

  it('imports a markdown bullet list through the stock import path', async () => {
    const editor = await mount();
    editor.update(() => {
      $convertFromMarkdownString('- one\n- two', EX_TRANSFORMERS, undefined, true);
    }, { discrete: true });
    let hasList = false;
    editor.getEditorState().read(() => {
      hasList = $getRoot().getChildren().some((c) => c.getType() === 'list');
    });
    expect(hasList).toBe(true);
  });

  it('round-trips a stored mention through markdown import (textNode.replace path)', async () => {
    const editor = await mount();
    editor.update(() => {
      $convertFromMarkdownString('hi @[u-9|Bob]', EX_TRANSFORMERS, undefined, true);
    }, { discrete: true });
    let hasMention = false;
    editor.getEditorState().read(() => {
      const walk = (n: { getType: () => string; getChildren?: () => unknown[] }) => {
        if (n.getType() === 'mention') { hasMention = true; return; }
        for (const c of (n.getChildren?.() ?? [])) walk(c as typeof n);
      };
      walk($getRoot() as never);
    });
    expect(hasMention).toBe(true);
  });

  it('the ordered-list transformer creates a fresh numbered list for live typing (isImport=false)', async () => {
    const editor = await mount();
    // EX_TRANSFORMERS[3] is the ordered-list element transformer; calling its
    // replace with isImport=false takes the live-create branch ($createListNode
    // with the parsed start number) rather than the stock import merge.
    const ordered = EX_TRANSFORMERS[3] as {
      replace: (parent: unknown, children: unknown[], match: string[], isImport: boolean) => void;
    };
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      const text = $createTextNode('first item');
      para.append(text);
      root.append(para);
      // match[2] is the captured start number for an ordered list.
      ordered.replace(para, [text], ['3. ', '', '3'], false);
    }, { discrete: true });
    let listType = '';
    editor.getEditorState().read(() => {
      const list = $getRoot().getChildren().find((c) => c.getType() === 'list') as { getListType?: () => string } | undefined;
      listType = list?.getListType?.() ?? '';
    });
    expect(listType).toBe('number');
  });
});
