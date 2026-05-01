import { $createTextNode, type LexicalNode, type TextNode } from 'lexical';

// Common mention/channel-mention insertion path: replace the trigger
// query node with the freshly-created decorator node, append a single
// trailing space, and park the caret after the space. Without the
// explicit caret park, Lexical leaves the selection wherever it was
// inside the now-removed query node — the caret visually lands inside
// the pill and the popup re-resolves before close fully runs.
export function $replaceWithDecoratorAndTrailingSpace(
  nodeToReplace: TextNode | null,
  decorator: LexicalNode,
): void {
  nodeToReplace?.replace(decorator);
  const trailing = $createTextNode(' ');
  decorator.insertAfter(trailing);
  trailing.select(1, 1);
}
