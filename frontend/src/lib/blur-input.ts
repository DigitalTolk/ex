// Blurs the focused text input/textarea/contenteditable, which dismisses
// the on-screen (iOS) keyboard. A no-op when nothing editable is focused.
export function blurActiveInput() {
  const el = document.activeElement;
  if (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  ) {
    el.blur();
  }
}
