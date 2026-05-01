import { forwardRef, useMemo } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { TabIndentationPlugin } from '@lexical/react/LexicalTabIndentationPlugin';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { QuoteNode } from '@lexical/rich-text';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { $convertFromMarkdownString } from '@lexical/markdown';
import type { InitialConfigType } from '@lexical/react/LexicalComposer';

import { MentionNode } from './lexical/nodes/MentionNode';
import { ChannelMentionNode } from './lexical/nodes/ChannelMentionNode';
import { ExListNode } from './lexical/nodes/ExListNode';
import { EX_TRANSFORMERS } from './lexical/transformers';
import { UserMentionsPlugin } from './lexical/plugins/UserMentionsPlugin';
import { ChannelMentionsPlugin } from './lexical/plugins/ChannelMentionsPlugin';
import { EmojiShortcutsPlugin } from './lexical/plugins/EmojiShortcutsPlugin';
import { SubmitOnEnterPlugin } from './lexical/plugins/SubmitOnEnterPlugin';
import { QuoteContinuationPlugin } from './lexical/plugins/QuoteContinuationPlugin';
import { CodeBlockExitPlugin } from './lexical/plugins/CodeBlockExitPlugin';
import { MarkdownShortcutFallbackPlugin } from './lexical/plugins/MarkdownShortcutFallbackPlugin';
import { PasteFilesPlugin } from './lexical/plugins/PasteFilesPlugin';
import { PasteLinkPlugin } from './lexical/plugins/PasteLinkPlugin';
import { MarkdownChangePlugin } from './lexical/plugins/MarkdownChangePlugin';
import {
  ImperativeHandlePlugin,
  type WysiwygEditorHandle,
  type ActiveFormat,
} from './lexical/plugins/ImperativeHandlePlugin';

export type { WysiwygEditorHandle, ActiveFormat };

interface Props {
  initialBody?: string;
  onChange?: (markdown: string) => void;
  onSubmit?: (markdown: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  onPasteFiles?: (files: File[]) => void;
}

// Lexical theme — pure class hooks the editor adds to its rendered
// DOM. Keeping the theme in code (instead of CSS-only) lets us match
// the surrounding shadcn/Tailwind tokens without relying on
// !important overrides.
const THEME = {
  paragraph: 'leading-snug',
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    strikethrough: 'line-through',
    code: 'rounded bg-muted px-1.5 py-0.5 text-sm font-mono',
  },
  list: {
    ul: 'list-disc pl-6 my-1',
    ol: 'list-decimal pl-6 my-1',
    listitem: 'my-0.5',
  },
  quote: 'border-l-2 border-muted-foreground/30 pl-3 my-1 text-muted-foreground',
  link: 'text-primary underline',
  code: 'block bg-muted rounded px-2 py-1 my-1 text-sm font-mono whitespace-pre-wrap',
};

export const WysiwygEditor = forwardRef<WysiwygEditorHandle, Props>(function WysiwygEditor(
  {
    initialBody = '',
    onChange,
    onSubmit,
    onCancel,
    placeholder,
    ariaLabel = 'Message input',
    className = '',
    onPasteFiles,
  },
  ref,
) {
  // Initial config is read once on mount. We seed the markdown via the
  // editorState callback below — Lexical re-renders deterministically
  // from there.
  const initialConfig = useMemo<InitialConfigType>(() => ({
    namespace: 'WysiwygEditor',
    theme: THEME,
    nodes: [
      // HeadingNode intentionally absent — see EX_TRANSFORMERS.
      QuoteNode,
      CodeNode,
      CodeHighlightNode,
      // ExListNode replaces stock ListNode to drop the upstream
      // auto-merge $transform — see the node file for rationale.
      // Lexical's class-replacement registry requires the subclass to
      // declare its own type and be registered as a plain entry too,
      // so its static getType() / clone() are filled in. The entry
      // below maps every $createListNode call to ExListNode.
      ExListNode,
      { replace: ListNode, with: (n: ListNode) => new ExListNode(n.getListType(), n.getStart()), withKlass: ExListNode },
      ListItemNode,
      LinkNode,
      AutoLinkNode,
      MentionNode,
      ChannelMentionNode,
    ],
    editorState: () => $convertFromMarkdownString(initialBody, EX_TRANSFORMERS, undefined, true),
    onError: (error) => {
      // Lexical surfaces parse errors as developer warnings — we don't
      // want them to crash the chat, but we want to know in dev.
      console.error('[Lexical]', error);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className={'relative ' + className}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              aria-label={ariaLabel}
              className="wysiwyg-editor min-h-[60px] max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words text-sm focus:outline-none"
              role="textbox"
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-0 top-0 select-none text-sm text-muted-foreground">
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <TabIndentationPlugin />
        <MarkdownShortcutPlugin transformers={EX_TRANSFORMERS} />
        <MarkdownShortcutFallbackPlugin />
        <UserMentionsPlugin />
        <ChannelMentionsPlugin />
        <EmojiShortcutsPlugin />
        <QuoteContinuationPlugin />
        <CodeBlockExitPlugin />
        <SubmitOnEnterPlugin onSubmit={onSubmit} onCancel={onCancel} />
        <PasteFilesPlugin onPasteFiles={onPasteFiles} />
        <PasteLinkPlugin />
        <MarkdownChangePlugin onChange={onChange} />
        <ImperativeHandlePlugin imperativeRef={ref} />
      </div>
    </LexicalComposer>
  );
});
