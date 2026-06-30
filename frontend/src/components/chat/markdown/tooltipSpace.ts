// composerTooltipSpace bounds the CodeMirror autocomplete placement to the
// VISUAL viewport — the area above the on-screen keyboard. CM otherwise measures
// against window.innerHeight, which does NOT shrink when the mobile keyboard
// opens, so it thinks there's room below the cursor and renders the mention /
// emoji / channel typeahead behind the keyboard. Constraining `bottom` to the
// keyboard top makes CM flip the popup ABOVE the cursor when needed. Falls back
// to the layout viewport where visualViewport is unavailable (older webviews).
//
// Lives in its own module (not MarkdownEditor.tsx) so that component file keeps
// a component-only export surface for react-refresh / the React compiler.
export function composerTooltipSpace(): { top: number; left: number; bottom: number; right: number } {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) {
    return { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  }
  return {
    top: vv.offsetTop,
    left: vv.offsetLeft,
    bottom: vv.offsetTop + vv.height,
    right: vv.offsetLeft + vv.width,
  };
}
