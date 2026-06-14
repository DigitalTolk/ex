import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $createLineBreakNode,
  $createTextNode,
  $getSelection,
  $getRoot,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_NORMAL,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
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

// Captures the fence in [1] and the optional first non-space token as
// language hint in [2]. The hint deliberately accepts common symbolic
// names such as c++, c#, f#, and objective-c.
const CODE_START_REGEX = /^([ \t]*`{3,})(\S+)?[ \t]?$/;
const PASTED_FENCED_CODE_REGEX = /^[ \t]*`{3,}(\S+)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*`{3,}[ \t]*$/;

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
        /* istanbul ignore next -- a text node that is neither the paragraph's first child nor preceded by a LineBreakNode requires two adjacent un-merged text nodes, a state Lexical normalizes away (adjacent text nodes always merge), so this guard's true arm is not reachable. */
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
      // NORMAL priority (above SubmitOnEnter at LOW) so an opening
      // fence converts immediately for both Enter and Shift+Enter.
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
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
          const isFirstChild = paragraph.getFirstChild() === anchorNode;
          const afterLineBreak = $isLineBreakNode(previousSibling);
          /* istanbul ignore next -- mirrors the transform guard above: an anchor text node that is neither first child nor after a LineBreakNode requires un-merged adjacent text nodes, which Lexical normalizes away, so this true arm is unreachable. */
          if (!isFirstChild && !afterLineBreak) return false;

          const converted = convertOpeningFenceToCodeBlock(
            paragraph,
            anchorNode,
            afterLineBreak ? previousSibling : null,
          );
          if (!converted) return false;
          event?.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const clipboardData = (event as ClipboardEvent).clipboardData;
          if (!clipboardData) return false;
          const text = clipboardData.getData('text/plain');
          const match = text.match(PASTED_FENCED_CODE_REGEX);
          if (!match) return false;

          const currentSelection = $getSelection();
          const selection = $isRangeSelection(currentSelection) ? currentSelection : $getRoot().selectEnd();
          /* istanbul ignore next -- selection is either the existing RangeSelection or $getRoot().selectEnd(), which always yields a RangeSelection, so this re-check's true arm is unreachable defensive code. */
          if (!$isRangeSelection(selection)) return false;
          const codeNode = createCodeNodeFromText(match[2], match[1]);
          const anchor = selection.anchor.getNode();
          const paragraph = $isParagraphNode(anchor) ? anchor : anchor.getParent();
          if (!$isParagraphNode(paragraph)) return false;
          event.preventDefault();
          if (paragraph.getTextContent() === '') {
            paragraph.replace(codeNode);
          } else {
            paragraph.insertAfter(codeNode);
          }
          const nextParagraph = $createParagraphNode();
          codeNode.insertAfter(nextParagraph);
          nextParagraph.select(0, 0);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor]);

  return null;
}

function convertOpeningFenceToCodeBlock(
  paragraph: ReturnType<typeof $createParagraphNode>,
  openingText: TextNode,
  previousLineBreak: LexicalNode | null,
): boolean {
  const textContent = openingText.getTextContent();
  const match = textContent.match(CODE_START_REGEX);
  if (!match || match[0].length !== textContent.length) return false;

  const target = previousLineBreak ? splitAtLineBreak(paragraph, openingText, previousLineBreak) : paragraph;
  const codeNode = $createCodeNode(match[2]);
  target.replace(codeNode);
  codeNode.selectEnd();
  return true;
}

function createCodeNodeFromText(text: string, language?: string): ReturnType<typeof $createCodeNode> {
  const codeNode = $createCodeNode(language);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line) codeNode.append($createTextNode(line));
    if (index < lines.length - 1) codeNode.append($createLineBreakNode());
  });
  return codeNode;
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
