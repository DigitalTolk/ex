import { describe, expect, it } from 'vitest';
import { defaultKeymap } from '@codemirror/commands';
import type { KeyBinding } from '@codemirror/view';
import { historyShortcuts, historyStepFor, withoutHistoryKeys } from './history-shortcut';

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

  it('leaves every other Mac chord alone', () => {
    for (const init of [
      { key: '[', code: 'BracketLeft' },
      { key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true },
      { key: '[', code: 'BracketLeft', metaKey: true, ctrlKey: true },
      { key: '[', code: 'BracketLeft', metaKey: true, altKey: true },
      { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true },
      { key: 'k', code: 'KeyK', metaKey: true },
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

  it("drops the editor's Alt+← and Alt+→ elsewhere, and nothing else", () => {
    const kept = keysOn(withoutHistoryKeys(defaultKeymap, false), false);
    expect(kept).not.toContain('Alt-ArrowLeft');
    expect(kept).not.toContain('Alt-ArrowRight');
    expect(kept).toContain('Mod-[');
    expect(kept.length).toBe(defaultKeymap.length - 2);
  });

  it('reads a Mac-only binding as having no key elsewhere', () => {
    const macOnly: KeyBinding = { mac: 'Mod-[', run: () => true };
    expect(withoutHistoryKeys([macOnly], false)).toEqual([macOnly]);
    expect(withoutHistoryKeys([macOnly], true)).toEqual([]);
  });
});
