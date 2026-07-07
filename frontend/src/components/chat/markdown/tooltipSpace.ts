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

// ---- Native keyboard tracking (Capacitor / WKWebView) ----
// Mobile Safari shrinks window.visualViewport when the on-screen keyboard
// opens — but WKWebView (the Capacitor iOS shell) does NOT: its visualViewport
// keeps reporting the full webview even while the keyboard covers half of it,
// so the visual-viewport bound below never engages in the native app and the
// typeahead still landed under the keyboard. The Capacitor Keyboard plugin
// bridges the native geometry as `keyboardWillShow`/`keyboardWillHide` window
// events carrying keyboardHeight; we fold that into the space bound. In plain
// browsers the events never fire and the visualViewport path stands alone.

let nativeKeyboardHeight = 0;
// window.innerHeight captured when the keyboard reported in — if the shell
// RESIZES the webview for the keyboard (Capacitor "native" resize mode), the
// window itself shrinks and the keyboard no longer overlaps the layout
// viewport; only the un-shrunk remainder must be subtracted.
let innerHeightAtKeyboardShow = 0;

// keyboardOverlap returns how many px of the CURRENT layout viewport the
// native keyboard covers: the reported height minus however much the window
// already shrank since the keyboard appeared.
export function keyboardOverlap(kbHeight: number, heightAtShow: number, currentHeight: number): number {
  const shrunk = Math.max(0, heightAtShow - currentHeight);
  return Math.max(0, kbHeight - shrunk);
}

// Capacitor delivers the height either directly on the event object (its
// window-event bridge assigns the payload onto the CustomEvent) or under
// `detail` depending on shell version — accept both.
export function readKeyboardHeight(ev: Event): number {
  const direct = (ev as unknown as { keyboardHeight?: unknown }).keyboardHeight;
  if (typeof direct === 'number') return direct;
  const detail = (ev as CustomEvent<{ keyboardHeight?: unknown }>).detail;
  return typeof detail?.keyboardHeight === 'number' ? detail.keyboardHeight : 0;
}

function onNativeKeyboardShow(ev: Event): void {
  nativeKeyboardHeight = readKeyboardHeight(ev);
  innerHeightAtKeyboardShow = window.innerHeight;
}

function onNativeKeyboardHide(): void {
  nativeKeyboardHeight = 0;
  innerHeightAtKeyboardShow = 0;
}

// Test seam: Playwright cannot shrink a real browser's visualViewport, so the
// placement tests simulate the iOS keyboard by overriding the reported space.
// Production never sets this.
let testSpaceOverride: (() => TooltipSpace) | null = null;
export function overrideComposerTooltipSpaceForTests(fn: (() => TooltipSpace) | null): void {
  testSpaceOverride = fn;
}

export function composerTooltipSpace(): TooltipSpace {
  if (testSpaceOverride) return testSpaceOverride();
  // Native keyboard bound (Capacitor WKWebView; 0 in plain browsers).
  const nativeBottom =
    window.innerHeight -
    (nativeKeyboardHeight > 0
      ? keyboardOverlap(nativeKeyboardHeight, innerHeightAtKeyboardShow, window.innerHeight)
      : 0);
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) {
    return { top: 0, left: 0, bottom: nativeBottom, right: window.innerWidth };
  }
  return {
    top: vv.offsetTop,
    left: vv.offsetLeft,
    // Whichever source knows about the keyboard wins: mobile Safari shrinks
    // the visualViewport, the Capacitor shell reports native geometry.
    bottom: Math.min(vv.offsetTop + vv.height, nativeBottom),
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
    private readonly onShow: (ev: Event) => void;
    private readonly onHide: () => void;
    constructor(view: EditorView) {
      this.view = view;
      this.reposition = () => repositionTooltips(this.view);
      window.visualViewport?.addEventListener('resize', this.reposition);
      window.visualViewport?.addEventListener('scroll', this.reposition);
      // Shells that RESIZE the webview on keyboard open (Capacitor native
      // resize mode) report the change as a window resize, not a
      // visualViewport event — cover both worlds.
      window.addEventListener('resize', this.reposition);
      // Capacitor keyboard geometry (WKWebView's visualViewport ignores the
      // keyboard entirely — see the tracking block above).
      this.onShow = (ev) => {
        onNativeKeyboardShow(ev);
        this.reposition();
      };
      this.onHide = () => {
        onNativeKeyboardHide();
        this.reposition();
      };
      window.addEventListener('keyboardWillShow', this.onShow);
      window.addEventListener('keyboardDidShow', this.onShow);
      window.addEventListener('keyboardWillHide', this.onHide);
      window.addEventListener('keyboardDidHide', this.onHide);
    }
    destroy() {
      window.visualViewport?.removeEventListener('resize', this.reposition);
      window.visualViewport?.removeEventListener('scroll', this.reposition);
      window.removeEventListener('resize', this.reposition);
      window.removeEventListener('keyboardWillShow', this.onShow);
      window.removeEventListener('keyboardDidShow', this.onShow);
      window.removeEventListener('keyboardWillHide', this.onHide);
      window.removeEventListener('keyboardDidHide', this.onHide);
    }
  },
);
