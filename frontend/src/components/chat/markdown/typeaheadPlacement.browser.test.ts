import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, repositionTooltips } from '@codemirror/view';
import { startCompletion } from '@codemirror/autocomplete';
import { composerAutocomplete, type CompletionProviders } from './extensions/completions';
import {
  composerTooltips,
  composerTooltipSpace,
  keyboardOverlap,
  overrideComposerTooltipSpaceForTests,
  readKeyboardHeight,
  visualViewportRepositioner,
} from './tooltipSpace';

// Regression tests for "typeahead opens under the iOS keyboard". Playwright
// cannot open a real on-screen keyboard, so the keyboard is simulated through
// the same space bound production reads (composerTooltipSpace): everything
// below the caret is declared unavailable, exactly what a keyboard does.
// What IS real here: the production tooltip config (composerTooltips — the
// exact extension MarkdownEditor mounts), the real autocomplete, and the real
// WebKit/Chromium positioning path.

const providers: CompletionProviders = {
  users: () => [
    { id: 'u1', displayName: 'Alice' },
    { id: 'u2', displayName: 'Alan' },
    { id: 'u3', displayName: 'Alba' },
  ],
  online: () => new Set(['u1']),
  memberIds: () => null,
  channels: () => [],
  customEmojis: () => [],
  skinTone: () => '',
};

function mountComposerLike(doc: string): EditorView {
  const host = document.createElement('div');
  // Park the editor mid-viewport so there is genuine room above the caret,
  // like the real composer sitting above the keyboard.
  host.style.cssText = 'position:absolute; top:55vh; left:0; right:0;';
  document.body.appendChild(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [composerAutocomplete(providers), composerTooltips(), visualViewportRepositioner],
    }),
  });
}

function tooltipEl(): HTMLElement | null {
  return document.body.querySelector('.cm-tooltip-autocomplete');
}

afterEach(() => {
  overrideComposerTooltipSpaceForTests(null);
});

describe('composer typeahead placement', () => {
  it('positions the popup in layout space (absolute in <body>), never position:fixed', async () => {
    // position:fixed is re-based against the visual viewport when iOS pans it
    // for the keyboard, shifting the popup down by the pan offset — under the
    // keyboard. Absolute-in-body coordinates are immune. Pin the mode.
    const view = mountComposerLike('@al');
    startCompletion(view);
    await vi.waitFor(() => expect(tooltipEl()).not.toBeNull());

    const tip = tooltipEl()!;
    expect(getComputedStyle(tip).position).toBe('absolute');
    // …and it is portaled out of the editor into the body-level container.
    expect(tip.closest('.cm-editor')).toBeNull();
    expect(document.body.contains(tip)).toBe(true);
    view.destroy();
  });

  it('flips above the caret when the keyboard eats the space below', async () => {
    const view = mountComposerLike('@al');
    startCompletion(view);
    await vi.waitFor(() => expect(tooltipEl()).not.toBeNull());

    const caret = view.coordsAtPos(view.state.selection.main.head)!;
    // Simulated keyboard: the visual viewport ends just under the caret.
    overrideComposerTooltipSpaceForTests(() => ({
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: caret.bottom + 8,
    }));
    repositionTooltips(view);

    await vi.waitFor(() => {
      const tip = tooltipEl()!;
      expect(tip.classList.contains('cm-tooltip-above')).toBe(true);
      expect(tip.getBoundingClientRect().bottom).toBeLessThanOrEqual(caret.top + 1);
    });
    view.destroy();
  });

  it('keeps natural downward placement while there is room below the caret', async () => {
    // The user-confirmed contract: placement stays natural — scrolled-up /
    // high-on-screen carets still open downward into visible space.
    const view = mountComposerLike('@al');
    startCompletion(view);
    await vi.waitFor(() => expect(tooltipEl()).not.toBeNull());

    const caret = view.coordsAtPos(view.state.selection.main.head)!;
    await vi.waitFor(() => {
      const tip = tooltipEl()!;
      expect(tip.classList.contains('cm-tooltip-below')).toBe(true);
      expect(tip.getBoundingClientRect().top).toBeGreaterThanOrEqual(caret.bottom - 1);
    });
    view.destroy();
  });
});

describe('native (Capacitor) keyboard geometry', () => {
  // WKWebView's visualViewport does NOT shrink for the on-screen keyboard —
  // the Capacitor shell reports it via keyboardWillShow/Hide window events.
  // These pin that the reported geometry constrains the space bound and that
  // the events re-run tooltip placement.

  function fireKeyboard(name: string, init?: { direct?: number; detail?: number }) {
    const ev = new CustomEvent(name, init?.detail !== undefined ? { detail: { keyboardHeight: init.detail } } : undefined);
    if (init?.direct !== undefined) {
      Object.assign(ev, { keyboardHeight: init.direct });
    }
    window.dispatchEvent(ev);
  }

  it('keyboardOverlap subtracts however much the window already shrank', () => {
    // Overlay mode (resize: none): window kept its height → full overlap.
    expect(keyboardOverlap(300, 800, 800)).toBe(300);
    // Native resize mode: window already shrank by the keyboard → no overlap.
    expect(keyboardOverlap(300, 800, 500)).toBe(0);
    // Partial resize (accessory bar): only the remainder overlaps.
    expect(keyboardOverlap(300, 800, 600)).toBe(100);
  });

  it('readKeyboardHeight accepts both Capacitor event shapes', () => {
    const direct = new CustomEvent('keyboardWillShow');
    Object.assign(direct, { keyboardHeight: 216 });
    expect(readKeyboardHeight(direct)).toBe(216);
    expect(readKeyboardHeight(new CustomEvent('keyboardWillShow', { detail: { keyboardHeight: 250 } }))).toBe(250);
    expect(readKeyboardHeight(new CustomEvent('keyboardWillShow'))).toBe(0);
  });

  it('constrains the space bound while the native keyboard is up, and restores on hide', async () => {
    const view = mountComposerLike('@al');
    startCompletion(view);
    await vi.waitFor(() => expect(tooltipEl()).not.toBeNull());
    try {
      const fullBottom = composerTooltipSpace().bottom;

      fireKeyboard('keyboardWillShow', { direct: 320 });
      expect(composerTooltipSpace().bottom).toBe(fullBottom - 320);

      // The flip actually happens against the native bound: with the caret
      // below the keyboard line, the popup must sit above the caret.
      const caret = view.coordsAtPos(view.state.selection.main.head)!;
      if (caret.bottom > window.innerHeight - 320) {
        await vi.waitFor(() => {
          expect(tooltipEl()!.classList.contains('cm-tooltip-above')).toBe(true);
        });
      }

      fireKeyboard('keyboardWillHide');
      expect(composerTooltipSpace().bottom).toBe(fullBottom);
    } finally {
      fireKeyboard('keyboardWillHide');
      view.destroy();
    }
  });
});
