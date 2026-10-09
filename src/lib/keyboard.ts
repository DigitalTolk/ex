// Shared on-screen keyboard helpers for the app root's keyboard inset
// (hooks/useKeyboardInset) and the composer's tooltip placement
// (chat/markdown/tooltipSpace). Kept free of editor imports so the app root
// can use it.

// keyboardOverlap returns how many px of the CURRENT layout viewport the
// native keyboard covers: the reported height minus however much the window
// already shrank since the keyboard appeared (a shell that resizes the webview
// for the keyboard already made room for that part).
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

// The elements that raise the on-screen keyboard when focused.
export const TEXT_FIELD_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]';

export function isTextField(el: Element | null): boolean {
  return el instanceof HTMLElement && el.matches(TEXT_FIELD_SELECTOR);
}
