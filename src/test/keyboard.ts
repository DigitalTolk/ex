// The on-screen keyboard for browser tests. Playwright can't raise a real
// one, so it is reported the way the Capacitor shell reports it. Mount
// KeyboardInsetTracker (./KeyboardInsetTracker) for the app to follow it.

export function fireKeyboard(name: 'keyboardWillShow' | 'keyboardWillHide', height = 0) {
  window.dispatchEvent(Object.assign(new CustomEvent(name), { keyboardHeight: height }));
}

// Long enough for a surface easing along with the keyboard
// (KEYBOARD_SETTLE_MS) to arrive.
export function keyboardSettled() {
  return new Promise((resolve) => setTimeout(resolve, 400));
}
