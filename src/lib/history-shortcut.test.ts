import { describe, expect, it } from 'vitest';
import { defaultKeymap, selectSyntaxLeft, selectSyntaxRight } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, type KeyBinding } from '@codemirror/view';
import {
  claimHistoryKeys,
  historyKeyBindings,
  historyKeysWillStep,
  historyShortcuts,
  historyStepFor,
  withoutHistoryKeys,
} from './history-shortcut';

const press = (init: Partial<KeyboardEventInit>) => new KeyboardEvent('keydown', init);

describe('historyStepFor', () => {
  it('reads ⌘[ and ⌘] on a Mac', () => {
    expect(historyStepFor(press({ key: '[', code: 'BracketLeft', metaKey: true }), true)).toBe('back');
    expect(historyStepFor(press({ key: ']', code: 'BracketRight', metaKey: true }), true)).toBe('forward');
    // The same keys on another layout (Swedish: Å and ^)…
    expect(historyStepFor(press({ key: 'å', code: 'BracketLeft', metaKey: true }), true)).toBe('back');
    expect(historyStepFor(press({ key: '¨', code: 'BracketRight', metaKey: true }), true)).toBe('forward');
    // …and the brackets where a layout puts them elsewhere (Dvorak).
    expect(historyStepFor(press({ key: '[', code: 'Minus', metaKey: true }), true)).toBe('back');
    expect(historyStepFor(press({ key: ']', code: 'Equal', metaKey: true }), true)).toBe('forward');
  });

  // Where those keys type another ASCII character, that is what they are.
  it('leaves the bracket keys alone where a layout types something else on them', () => {
    // German, Spanish, Italian: BracketRight types '+', and ⌘+ is zoom.
    expect(historyStepFor(press({ key: '+', code: 'BracketRight', metaKey: true }), true)).toBeNull();
    expect(historyStepFor(press({ key: '`', code: 'BracketLeft', metaKey: true }), true)).toBeNull();
    // Dvorak: ⌘/ and ⌘= sit on BracketLeft and BracketRight.
    expect(historyStepFor(press({ key: '/', code: 'BracketLeft', metaKey: true }), true)).toBeNull();
    expect(historyStepFor(press({ key: '=', code: 'BracketRight', metaKey: true }), true)).toBeNull();
    // A key with a name rather than a character still counts where it sits.
    expect(historyStepFor(press({ key: 'Dead', code: 'BracketLeft', metaKey: true }), true)).toBe('back');
  });

  it('leaves every other Mac chord alone', () => {
    for (const init of [
      { key: '[', code: 'BracketLeft' },
      { key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true },
      { key: '[', code: 'BracketLeft', metaKey: true, ctrlKey: true },
      { key: '[', code: 'BracketLeft', metaKey: true, altKey: true },
      { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true },
      { key: 'k', code: 'KeyK', metaKey: true },
      // A non-ASCII character away from the bracket keys (Swedish ö).
      { key: 'ö', code: 'Semicolon', metaKey: true },
    ]) {
      expect(historyStepFor(press(init), true)).toBeNull();
    }
  });

  it('reads Alt+← and Alt+→ elsewhere', () => {
    expect(historyStepFor(press({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), false)).toBe('back');
    expect(historyStepFor(press({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }), false)).toBe('forward');
  });

  it('leaves every other chord alone elsewhere', () => {
    for (const init of [
      { key: 'ArrowLeft', code: 'ArrowLeft' },
      { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true },
      { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, ctrlKey: true },
      { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, metaKey: true },
      { key: '[', code: 'BracketLeft', ctrlKey: true },
      { key: 'ArrowUp', code: 'ArrowUp', altKey: true },
    ]) {
      expect(historyStepFor(press(init), false)).toBeNull();
    }
  });
});

describe('historyShortcuts', () => {
  it('names the keys for each platform', () => {
    expect(historyShortcuts(true)).toEqual({
      back: { label: '⌘[', aria: 'Meta+[' },
      forward: { label: '⌘]', aria: 'Meta+]' },
    });
    expect(historyShortcuts(false)).toEqual({
      back: { label: 'Alt ←', aria: 'Alt+ArrowLeft' },
      forward: { label: 'Alt →', aria: 'Alt+ArrowRight' },
    });
  });
});

describe('withoutHistoryKeys', () => {
  const keysOn = (bindings: readonly KeyBinding[], apple: boolean) =>
    bindings.map((b) => (apple && b.mac) || b.key);

  it("drops the editor's ⌘[ and ⌘] on a Mac, and nothing else", () => {
    const kept = keysOn(withoutHistoryKeys(defaultKeymap, true), true);
    expect(kept).not.toContain('Mod-[');
    expect(kept).not.toContain('Mod-]');
    // Option+arrows still move by word.
    expect(kept).toContain('Alt-ArrowLeft');
    expect(kept.length).toBe(defaultKeymap.length - 2);
  });

  it("takes only the plain Alt+← and Alt+→ from the editor elsewhere, keeping select-by-syntax", () => {
    const stripped = withoutHistoryKeys(defaultKeymap, false);
    const at = (key: string) => stripped.find((b) => b.key === key)!;
    expect(at('Alt-ArrowLeft').run).toBeUndefined();
    expect(at('Alt-ArrowLeft').shift).toBe(selectSyntaxLeft);
    expect(at('Alt-ArrowRight').run).toBeUndefined();
    expect(at('Alt-ArrowRight').shift).toBe(selectSyntaxRight);
    expect(keysOn(stripped, false)).toContain('Mod-[');
    expect(stripped.length).toBe(defaultKeymap.length);
  });

  it('reads a Mac-only binding as having no key elsewhere', () => {
    const macOnly: KeyBinding = { mac: 'Mod-[', run: () => true };
    expect(withoutHistoryKeys([macOnly], false)).toEqual([macOnly]);
    expect(withoutHistoryKeys([macOnly], true)).toEqual([]);
  });
});

describe('historyKeysWillStep', () => {
  it('answers from whoever claimed the keys, and no once they let go', () => {
    expect(historyKeysWillStep('back')).toBe(false);
    const release = claimHistoryKeys((to) => to === 'back');
    expect(historyKeysWillStep('back')).toBe(true);
    expect(historyKeysWillStep('forward')).toBe(false);
    release();
    expect(historyKeysWillStep('back')).toBe(false);
  });

  it('keeps a newer claim when an older one lets go', () => {
    const releaseOld = claimHistoryKeys(() => false);
    const releaseNew = claimHistoryKeys(() => true);
    releaseOld();
    expect(historyKeysWillStep('back')).toBe(true);
    releaseNew();
    expect(historyKeysWillStep('back')).toBe(false);
  });
});

describe('historyKeyBindings', () => {
  function editor(doc: string, selection: number) {
    return new EditorView({ state: EditorState.create({ doc, selection: { anchor: selection }, extensions: [markdown()] }) });
  }

  it('indents with ⌘] and outdents with ⌘[ on a Mac unless Back or Forward will go somewhere', () => {
    const [back, forward] = historyKeyBindings(true);
    expect([back.key, forward.key]).toEqual(['Mod-[', 'Mod-]']);
    const view = editor('hello', 0);
    try {
      expect(forward.run!(view)).toBe(true);
      expect(view.state.doc.toString()).not.toBe('hello');
      expect(back.run!(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('hello');
      // Somewhere to go: the key is Back/Forward's, the editor lets it pass.
      const release = claimHistoryKeys(() => true);
      expect(back.run!(view)).toBe(false);
      expect(forward.run!(view)).toBe(false);
      expect(view.state.doc.toString()).toBe('hello');
      release();
    } finally {
      view.destroy();
    }
  });

  it('moves by syntax with Alt+← and Alt+→ elsewhere unless Back or Forward will go somewhere', () => {
    const [back, forward] = historyKeyBindings(false);
    expect([back.key, forward.key]).toEqual(['Alt-ArrowLeft', 'Alt-ArrowRight']);
    const view = editor('**one** two', 0);
    try {
      expect(forward.run!(view)).toBe(true);
      expect(view.state.selection.main.head).toBeGreaterThan(0);
      expect(back.run!(view)).toBe(true);
      expect(view.state.selection.main.head).toBe(0);
      const release = claimHistoryKeys((to) => to === 'forward');
      const head = view.state.selection.main.head;
      expect(forward.run!(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(head);
      release();
    } finally {
      view.destroy();
    }
  });
});
