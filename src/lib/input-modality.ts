import { isTextField } from '@/lib/keyboard';

// Which input the user is driving the app with — for the focus decisions the
// browser's own :focus-visible gets wrong. A browser treats every key as
// keyboard navigation, Escape included, so pressing Escape after a click
// dressed the clicked button in a keyboard focus ring (and the button a
// closing menu or dialog handed focus back to), and a focused message row
// pinned its toolbar open. Escape is not navigation: it closes things. After
// a pointer press it leaves the modality alone, and the focus left behind on
// a control is let go.

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);
// How long after Escape a focus handed back by a closing layer (a menu or
// dialog returns it to its trigger once its exit animation ends) is let go.
const ESCAPE_RELEASE_MS = 1000;

// Nothing yet, a pointer press, or a key that navigates or types (not
// Escape, not a bare modifier).
let modality: 'none' | 'pointer' | 'keyboard' = 'none';
let escapeAt = Number.NEGATIVE_INFINITY;
let tracking = false;

export function isKeyboardModality(): boolean {
  return modality === 'keyboard';
}

// A control keeps the focus a key gave it; a text field always keeps focus
// (typing continues there).
function letGo(el: EventTarget | null) {
  if (el instanceof HTMLElement && el !== document.body && !isTextField(el)) el.blur();
}

function onPointerDown() {
  modality = 'pointer';
  escapeAt = Number.NEGATIVE_INFINITY;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (modality !== 'pointer') return;
    escapeAt = performance.now();
    // Once the Escape has closed whatever it closes.
    window.setTimeout(() => letGo(document.activeElement), 0);
    return;
  }
  if (MODIFIER_KEYS.has(event.key)) return;
  modality = 'keyboard';
  escapeAt = Number.NEGATIVE_INFINITY;
}

// The focus a closing layer returns, once: a focus trap that pulls it back
// must not start a tug of war.
function onFocusIn(event: FocusEvent) {
  if (performance.now() - escapeAt > ESCAPE_RELEASE_MS) return;
  escapeAt = Number.NEGATIVE_INFINITY;
  letGo(event.target);
}

// Idempotent: every consumer may call it; the listeners go on once.
export function startInputModalityTracking(): void {
  if (tracking) return;
  tracking = true;
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);
}

// Test seam: module state outlives a test.
export function resetInputModalityForTests(): void {
  modality = 'none';
  escapeAt = Number.NEGATIVE_INFINITY;
}
