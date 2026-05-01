import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  COMMAND_PRIORITY_NORMAL,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
} from 'lexical';
import { $isQuoteNode, type QuoteNode } from '@lexical/rich-text';
import { $findMatchingParent, mergeRegister } from '@lexical/utils';
import { $currentLineIsEmpty } from './lineUtils';

// Slack-style multi-line blockquotes:
//   - Enter on a non-empty quote line keeps the caret in the same quote
//     and inserts a soft line break (so `> a` + Enter + `b` round-trips
//     as `> a\n> b`, not `> a\n\nb`).
//   - Enter on an empty line — or Backspace at the start of an empty
//     line — exits the quote into a fresh paragraph.
export function QuoteContinuationPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event && event.shiftKey) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const quote = $findMatchingParent(selection.anchor.getNode(), $isQuoteNode);
          if (!quote) return false;
          if ($currentLineIsEmpty(selection)) {
            event?.preventDefault();
            exitQuote(quote);
            return true;
          }
          event?.preventDefault();
          selection.insertNodes([$createLineBreakNode()]);
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const quote = $findMatchingParent(selection.anchor.getNode(), $isQuoteNode);
          if (!quote) return false;
          if (!$currentLineIsEmpty(selection)) return false;
          event?.preventDefault();
          exitQuote(quote);
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
    );
  }, [editor]);

  return null;
}

function exitQuote(quote: QuoteNode): void {
  // Drop the trailing LineBreak that introduced the now-blank line so
  // the markdown round-trip doesn't keep an empty `> ` row.
  const tail = quote.getLastChild();
  if (tail && $isLineBreakNode(tail)) tail.remove();
  const para = $createParagraphNode();
  quote.insertAfter(para);
  para.select(0, 0);
}
