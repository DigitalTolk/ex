import type { Command, KeyBinding } from '@codemirror/view';
import { cursorSyntaxLeft, cursorSyntaxRight, indentLess, indentMore } from '@codemirror/commands';

// Back and Forward from the keyboard, as in Slack: ⌘[ and ⌘] on a Mac,
// Alt+← and Alt+→ elsewhere. Pure functions of the platform so both are
// testable anywhere (see lib/platform.ts).

export type HistoryStep = 'back' | 'forward';

type Keys = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

// A key that types a plain ASCII character: what it types is what it is.
const typesAscii = (key: string) => key.length === 1 && key >= ' ' && key <= '~';

// The step a key press asks for. On a Mac the bracket keys also count where
// they sit (right of P) when the layout prints something that isn't ASCII
// there (Swedish: å and ¨) — but not when they type another ASCII character:
// on German, Spanish and Italian layouts that key types '+', and ⌘+ is zoom;
// on Dvorak those keys are ⌘/ and ⌘=.
export function historyStepFor(e: Keys, apple: boolean): HistoryStep | null {
  if (e.shiftKey) return null;
  if (apple) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.key === '[') return 'back';
    if (e.key === ']') return 'forward';
    if (typesAscii(e.key)) return null;
    if (e.code === 'BracketLeft') return 'back';
    if (e.code === 'BracketRight') return 'forward';
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

// Whether the keys will step right now. The top bar claims them while it
// listens (it is not there on a phone, nor without the Navigation API) and
// answers from the live history; nobody claiming means they won't.
let stepper: ((to: HistoryStep) => boolean) | null = null;

export function claimHistoryKeys(canStep: (to: HistoryStep) => boolean): () => void {
  stepper = canStep;
  return () => {
    if (stepper === canStep) stepper = null;
  };
}

export function historyKeysWillStep(to: HistoryStep): boolean {
  return stepper?.(to) ?? false;
}

const HISTORY_KEYS = (apple: boolean) => (apple ? ['Mod-[', 'Mod-]'] : ['Alt-ArrowLeft', 'Alt-ArrowRight']);

// An editor keymap without its own plain use of those keys (CodeMirror
// indents on ⌘[ and ⌘], and moves by syntax on Alt+← and Alt+→);
// historyKeyBindings takes them over. A Shift variant (Alt+Shift+← selects by
// syntax) is no history key, so it stays. A binding's key on this platform is
// its `mac` one on a Mac, as CodeMirror reads it.
export function withoutHistoryKeys(bindings: readonly KeyBinding[], apple: boolean): KeyBinding[] {
  const taken = HISTORY_KEYS(apple);
  return bindings.flatMap((b) => {
    if (!taken.includes((apple && b.mac) || b.key || '')) return [b];
    return b.shift ? [{ ...b, run: undefined }] : [];
  });
}

// The editor's own commands on the history keys, yielding to Back and Forward
// only when those will actually go somewhere. Everywhere else — a phone, no
// Navigation API, the start or end of the history — the key keeps its editor
// meaning: on a Mac ⌘[ and ⌘] are the only way to indent, and a key the editor
// let through would reach the browser, whose own ⌘[ can leave the app.
export function historyKeyBindings(apple: boolean): KeyBinding[] {
  const yieldTo =
    (to: HistoryStep, own: Command): Command =>
    (view) =>
      historyKeysWillStep(to) ? false : own(view);
  const [backKey, forwardKey] = HISTORY_KEYS(apple);
  return [
    { key: backKey, run: yieldTo('back', apple ? indentLess : cursorSyntaxLeft) },
    { key: forwardKey, run: yieldTo('forward', apple ? indentMore : cursorSyntaxRight) },
  ];
}
