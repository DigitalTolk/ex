import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  COMMAND_PRIORITY_NORMAL,
  KEY_ENTER_COMMAND,
  TextNode,
  type LexicalNode,
} from 'lexical';
import { $createCodeNode } from '@lexical/code';
import { mergeRegister } from '@lexical/utils';
import type { ElementTransformer } from '@lexical/markdown';
import { EX_TRANSFORMERS } from '../transformers';

// Detects markdown block shortcuts (`- `, `1. `, `> `, ` ``` `) when
// Lexical's stock MarkdownShortcutPlugin doesn't.
//
// Two reasons we can't rely on Lexical's stock plugin:
//
//   1. Its element-transformer path uses an update listener with half
//      a dozen guard conditions — `selection.is(prevSelection)`,
//      `editor.isComposing()`, `dirtyLeaves.has(anchorKey)`, history
//      tags, an offset-delta check. At least one of those guards
//      bails on the keystroke after a block exit, so the user's
//      second attempt at any block formatting never converts.
//
//   2. Both its element- and multiline-element paths only fire when
//      the trigger text is literally the FIRST child of the paragraph
//      — `parentNode.getFirstChild() !== anchorNode` returns false.
//      In a chat composer where users press Shift+Enter for soft line
//      breaks, the trigger sitting on a new visual line (after a
//      <br>) is silently ignored: the paragraph's first child is the
//      LineBreakNode, not the trigger.
//
// We hook two paths to cover both cases:
//
//   • Element shortcuts (`- `, `1. `, `> `) trigger on space-typing,
//     so we use a TextNode transform — they fire unconditionally on
//     every dirty TextNode with no listener guards.
//
//   • The multiline code-block shortcut (` ``` `) triggers on Enter,
//     not on text input, so we use a KEY_ENTER_COMMAND handler at
//     NORMAL priority (above SubmitOnEnter at LOW).
//
// Both paths accept the trigger either as the paragraph's first child
// OR as the first node after a LineBreakNode. When it's after a soft
// break, we split the paragraph at that break before producing the
// new block — the original paragraph keeps the content above the
// break, the new block becomes a sibling after it.
//
// Conservative match: the trigger text node must contain ONLY the
// trigger pattern (text length === match length). A user editing
// existing text into "1. foo" isn't silently re-listed; the trigger
// has to be the literal thing they just typed.
const ELEMENT_TRANSFORMERS: ElementTransformer[] = EX_TRANSFORMERS.filter(
  (t): t is ElementTransformer => t.type === 'element',
);

// Stock @lexical/markdown's CODE_START_REGEX — see node_modules
// /@lexical/markdown/LexicalMarkdown.dev.js around line 939. Captures
// the fence in [1] and an optional language tag in [2].
const CODE_START_REGEX = /^([ \t]*`{3,})([\w-]+)?[ \t]?$/;

export function MarkdownShortcutFallbackPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return mergeRegister(
      editor.registerNodeTransform(TextNode, (textNode) => {
        const paragraph = textNode.getParent();
        if (!$isParagraphNode(paragraph)) return;
        const grandparent = paragraph.getParent();
        if (!grandparent || !$isRootOrShadowRoot(grandparent)) return;

        const previousSibling = textNode.getPreviousSibling();
        const isFirstChild = paragraph.getFirstChild() === textNode;
        const afterLineBreak = $isLineBreakNode(previousSibling);
        if (!isFirstChild && !afterLineBreak) return;

        const textContent = textNode.getTextContent();
        if (textContent.length === 0 || !textContent.endsWith(' ')) return;

        for (const transformer of ELEMENT_TRANSFORMERS) {
          const match = textContent.match(transformer.regExp);
          if (!match || match.index !== 0) continue;
          if (match[0].length !== textContent.length) continue;
          const target = afterLineBreak ? splitAtLineBreak(paragraph, textNode, previousSibling!) : paragraph;
          transformer.replace(target, [], match, false);
          return;
        }
      }),
      // Multiline code-block trigger fires on Enter. We claim it at
      // NORMAL priority (above SubmitOnEnter at LOW) only when the
      // trigger text sits AFTER a soft line break; the first-child
      // case is handled fine by Lexical's stock multiline path on
      // KEY_ENTER, so we let that run normally.
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event && event.shiftKey) return false;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
          const anchorNode = selection.anchor.getNode();
          if (!$isTextNode(anchorNode)) return false;
          if (selection.anchor.offset !== anchorNode.getTextContent().length) return false;
          const paragraph = anchorNode.getParent();
          if (!$isParagraphNode(paragraph)) return false;
          const grandparent = paragraph.getParent();
          if (!grandparent || !$isRootOrShadowRoot(grandparent)) return false;
          const previousSibling = anchorNode.getPreviousSibling();
          if (!$isLineBreakNode(previousSibling)) return false;

          const textContent = anchorNode.getTextContent();
          const match = textContent.match(CODE_START_REGEX);
          if (!match || match[0].length !== textContent.length) return false;

          editor.update(() => {
            const newPara = splitAtLineBreak(paragraph, anchorNode, previousSibling);
            const codeNode = $createCodeNode(match[2]);
            newPara.replace(codeNode);
            codeNode.select(0, 0);
          });
          event?.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
    );
  }, [editor]);

  return null;
}

function splitAtLineBreak(
  paragraph: ReturnType<typeof $createParagraphNode>,
  triggerText: TextNode,
  linebreak: LexicalNode,
): ReturnType<typeof $createParagraphNode> {
  const newPara = $createParagraphNode();
  paragraph.insertAfter(newPara);
  // Move the trigger text node and any subsequent siblings into the
  // new paragraph in their original order.
  let cursor: LexicalNode | null = triggerText;
  while (cursor) {
    const next: LexicalNode | null = cursor.getNextSibling();
    newPara.append(cursor);
    cursor = next;
  }
  // Drop the line break that introduced the trigger line; it's now
  // implicit in the paragraph break we just created.
  linebreak.remove();
  return newPara;
}
