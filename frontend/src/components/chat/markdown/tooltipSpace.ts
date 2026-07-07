import { ViewPlugin, repositionTooltips, tooltips, type EditorView } from '@codemirror/view';

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
export type TooltipSpace = { top: number; left: number; bottom: number; right: number };

// Test seam: Playwright cannot shrink a real browser's visualViewport, so the
// placement tests simulate the iOS keyboard by overriding the reported space.
// Production never sets this.
let testSpaceOverride: (() => TooltipSpace) | null = null;
export function overrideComposerTooltipSpaceForTests(fn: (() => TooltipSpace) | null): void {
  testSpaceOverride = fn;
}

export function composerTooltipSpace(): TooltipSpace {
  if (testSpaceOverride) return testSpaceOverride();
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

// composerTooltips is THE tooltip config for the composer (the placement
// browser tests mount this exact extension, so config drift fails CI).
//
// `parent: document.body` lifts the popup out of every clipping / transformed
// ancestor (Motion swipe offsets, overflow containers — see MarkdownEditor).
//
// `position: 'absolute'` — deliberately NOT 'fixed'. On iOS, when the
// on-screen keyboard opens WebKit often can't resize the page and instead
// PANS the visual viewport (visualViewport.offsetTop > 0). position:fixed
// elements are then re-based against the visual viewport, so coordinates
// CodeMirror computed in layout/client space render shifted DOWN by exactly
// the pan offset — landing the typeahead under the keyboard no matter what
// the space math said. CodeMirror even carries a Safari "makeAbsolute" kludge
// for this, but it only engages after it detects a drifted tooltip, racing
// the keyboard animation. Absolute positioning inside <body> lives in layout
// space from the start: immune to visual-viewport re-basing, and equivalent
// to fixed on every desktop browser (the app's <body> never scrolls).
export function composerTooltips() {
  return tooltips({ parent: document.body, position: 'absolute', tooltipSpace: composerTooltipSpace });
}

// visualViewportRepositioner makes the space bound above REACTIVE. CodeMirror
// re-measures tooltip placement on window resize / transactions — but NOT on
// visualViewport changes, and iOS reports the on-screen keyboard late (often
// after the typeahead already opened). A popup positioned against the stale
// viewport lands BEHIND the keyboard and nothing ever re-places it. Nudging
// repositionTooltips on every visualViewport resize/scroll re-runs placement
// against the fresh bound the moment the keyboard geometry lands — flipping
// the popup above the keyboard when needed while keeping CodeMirror's natural
// above/below choice (an inline edit high on the screen still opens downward
// into the visible space below the caret).
export const visualViewportRepositioner = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    private readonly reposition: () => void;
    constructor(view: EditorView) {
      this.view = view;
      this.reposition = () => repositionTooltips(this.view);
      window.visualViewport?.addEventListener('resize', this.reposition);
      window.visualViewport?.addEventListener('scroll', this.reposition);
      // Shells that RESIZE the webview on keyboard open (Capacitor native
      // resize mode) report the change as a window resize, not a
      // visualViewport event — cover both worlds.
      window.addEventListener('resize', this.reposition);
    }
    destroy() {
      window.visualViewport?.removeEventListener('resize', this.reposition);
      window.visualViewport?.removeEventListener('scroll', this.reposition);
      window.removeEventListener('resize', this.reposition);
    }
  },
);
