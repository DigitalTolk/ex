import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  COMMAND_PRIORITY_NORMAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalNode,
} from 'lexical';
import { $isCodeNode, type CodeNode } from '@lexical/code';
import { $findMatchingParent, mergeRegister } from '@lexical/utils';
import { $readCurrentLineText } from './lineUtils';

// Slack-style code-fence exit:
//   - Enter on a closing-fence line (current line is "```") strips the
//     fence and drops a fresh paragraph after the code node.
//   - ArrowDown on the last line of a code block also exits to a fresh
//     paragraph below — matches Slack/GitHub UX where users escape via
//     ↓ rather than typing the closing fence.
//
// Registered at NORMAL priority so it runs *before* SubmitOnEnterPlugin
// (LOW). When this plugin doesn't claim the event (caret outside a
// code block, or no exit condition met), it returns false and Lexical's
// default CodeNode.insertNewAfter inserts a soft newline — which is
// exactly what we want for in-block Enter.
export function CodeBlockExitPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event && event.shiftKey) return false;
          const target = readClosingFenceTarget();
          if (!target) return false;
          event?.preventDefault();
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            // Extend back over the closing-fence line and drop it in
            // one shot, then strip any leftover trailing LineBreak so
            // the code node doesn't keep a blank tail line.
            for (let i = 0; i < target.lineLength; i++) selection.deleteCharacter(true);
            const tail = target.codeNode.getLastChild();
            if (tail && $isLineBreakNode(tail)) tail.remove();
            appendParagraphAfter(target.codeNode);
          });
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event) => {
          if (event && (event.shiftKey || event.metaKey || event.altKey)) return false;
          const codeNode = readArrowDownExitTarget();
          if (!codeNode) return false;
          event?.preventDefault();
          editor.update(() => appendParagraphAfter(codeNode));
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
    );
  }, [editor]);

  return null;
}

function readClosingFenceTarget(): { codeNode: CodeNode; lineLength: number } | null {
  // Caller is inside a Lexical command handler which already runs in a
  // read context, so $getSelection is safe without an editor.read wrap.
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const codeNode = $findMatchingParent(selection.anchor.getNode(), $isCodeNode);
  if (!codeNode) return null;
  const line = $readCurrentLineText(selection);
  if (line.trim() !== '```') return null;
  return { codeNode, lineLength: line.length };
}

function readArrowDownExitTarget(): CodeNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const codeNode = $findMatchingParent(selection.anchor.getNode(), $isCodeNode);
  if (!codeNode) return null;
  if (hasFollowingLineBreak(selection.anchor.getNode())) return null;
  return codeNode;
}

function appendParagraphAfter(codeNode: CodeNode): void {
  const para = $createParagraphNode();
  codeNode.insertAfter(para);
  para.select(0, 0);
}

function hasFollowingLineBreak(anchor: LexicalNode): boolean {
  let next = anchor.getNextSibling();
  while (next) {
    if ($isLineBreakNode(next)) return true;
    next = next.getNextSibling();
  }
  return false;
}
