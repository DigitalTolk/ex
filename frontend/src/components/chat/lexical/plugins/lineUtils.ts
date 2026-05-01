import {
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type LexicalNode,
  type RangeSelection,
} from 'lexical';

// Read the text content on the current "line" — the run between the
// previous LineBreakNode (or the start of the containing element) and
// the caret. Used by Quote and Code Block exit logic which need to
// know whether the user is on a blank line or a closing-fence line.
//
// Selection's anchor can be either a TextNode + char offset OR an
// ElementNode + child index (when the caret sits between blocks or at
// the end of an empty line). Both shapes are handled here.
export function $readCurrentLineText(selection: RangeSelection): string {
  const anchor = selection.anchor.getNode();
  const anchorOffset = selection.anchor.offset;
  const parts: string[] = [];
  let prev = $startWalkingBackFrom(anchor, anchorOffset);
  if ($isTextNode(anchor)) {
    parts.push(anchor.getTextContent().slice(0, anchorOffset));
  }
  while (prev && !$isLineBreakNode(prev)) {
    if ($isTextNode(prev)) parts.unshift(prev.getTextContent());
    prev = prev.getPreviousSibling();
  }
  return parts.join('');
}

// Cheaper variant: returns true when the current line has no visible
// characters, without building the line's full text. Short-circuits on
// the first non-whitespace TextNode.
export function $currentLineIsEmpty(selection: RangeSelection): boolean {
  const anchor = selection.anchor.getNode();
  const anchorOffset = selection.anchor.offset;
  if ($isTextNode(anchor) && anchor.getTextContent().slice(0, anchorOffset).trim() !== '') {
    return false;
  }
  let prev = $startWalkingBackFrom(anchor, anchorOffset);
  while (prev && !$isLineBreakNode(prev)) {
    if ($isTextNode(prev) && prev.getTextContent().trim() !== '') return false;
    prev = prev.getPreviousSibling();
  }
  return true;
}

// Pick the node from which `prev`-walking starts. For a TextNode anchor
// that's the anchor's previous sibling; for an ElementNode anchor (caret
// sitting at a child index between blocks) it's the child immediately to
// the left. Anything else falls through to `getPreviousSibling`, which
// LexicalNode always exposes — keeps the helper union-safe without an
// else-branch the type system narrows to `never`.
function $startWalkingBackFrom(anchor: LexicalNode, anchorOffset: number): LexicalNode | null {
  if ($isElementNode(anchor)) {
    return anchor.getChildren()[anchorOffset - 1] ?? null;
  }
  return anchor.getPreviousSibling();
}
