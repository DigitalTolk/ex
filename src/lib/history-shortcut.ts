import type { KeyBinding } from '@codemirror/view';

// Back and Forward from the keyboard, as in Slack: ⌘[ and ⌘] on a Mac,
// Alt+← and Alt+→ elsewhere. Pure functions of the platform so both are
// testable anywhere (see lib/platform.ts).

export type HistoryStep = 'back' | 'forward';

type Keys = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

// The step a key press asks for. The Mac's bracket keys also count where
// they sit (right of P), whatever a keyboard layout prints on them.
export function historyStepFor(e: Keys, apple: boolean): HistoryStep | null {
  if (e.shiftKey) return null;
  if (apple) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.code === 'BracketLeft' || e.key === '[') return 'back';
    if (e.code === 'BracketRight' || e.key === ']') return 'forward';
    return null;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === 'ArrowLeft') return 'back';
  if (e.key === 'ArrowRight') return 'forward';
  return null;
}

export interface HistoryShortcut {
  // As shown in a tooltip.
  label: string;
  // As aria-keyshortcuts names it.
  aria: string;
}

export function historyShortcuts(apple: boolean): Record<HistoryStep, HistoryShortcut> {
  return apple
    ? { back: { label: '⌘[', aria: 'Meta+[' }, forward: { label: '⌘]', aria: 'Meta+]' } }
    : { back: { label: 'Alt ←', aria: 'Alt+ArrowLeft' }, forward: { label: 'Alt →', aria: 'Alt+ArrowRight' } };
}

// An editor keymap without its own use of those keys (CodeMirror indents on
// ⌘[ and ⌘], and moves by syntax on Alt+← and Alt+→), so they go back and
// forward from the message box too. A binding's key on this platform is its
// `mac` one on a Mac, as CodeMirror reads it.
export function withoutHistoryKeys(bindings: readonly KeyBinding[], apple: boolean): KeyBinding[] {
  const taken = apple ? ['Mod-[', 'Mod-]'] : ['Alt-ArrowLeft', 'Alt-ArrowRight'];
  return bindings.filter((b) => !taken.includes((apple && b.mac) || b.key || ''));
}
