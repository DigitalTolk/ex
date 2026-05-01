// Centralized window CustomEvent names + typed dispatch / subscribe
// helpers. Cross-component intents that don't fit naturally in React
// state (e.g., asking a sibling subtree to enter edit mode or reclaim
// focus) ride on `window.dispatchEvent` so they can cross any
// component boundary without prop-drilling. Keeping the names and
// payload shapes here prevents the typo-on-add-listener-but-not-
// dispatcher class of bug.

export const WINDOW_EVENTS = {
  EditMessage: 'ex:edit-message',
  FocusComposer: 'ex:focus-composer',
} as const;

export interface EditMessageDetail {
  messageId: string;
}

export interface FocusComposerDetail {
  parentID: string;
  inThread: boolean;
}

export function dispatchEditMessage(detail: EditMessageDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.EditMessage, { detail }));
}

export function dispatchFocusComposer(detail: FocusComposerDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.FocusComposer, { detail }));
}

// Edit-message uses a registry instead of per-message window
// listeners. With ~50 MessageItems on screen, the previous design
// installed ~50 window listeners that each filtered the same event
// by id; one singleton listener + a Map<messageId, handler> trims
// dispatch to one Map.get and unmount/mount churn to a Map write.
const editHandlers = new Map<string, () => void>();
let editListenerInstalled = false;

function ensureEditListener(): void {
  if (editListenerInstalled || typeof window === 'undefined') return;
  editListenerInstalled = true;
  window.addEventListener(WINDOW_EVENTS.EditMessage, (e: Event) => {
    const ce = e as CustomEvent<EditMessageDetail | undefined>;
    const id = ce.detail?.messageId;
    if (id) editHandlers.get(id)?.();
  });
}

export function registerEditMessageHandler(
  messageId: string,
  handler: () => void,
): () => void {
  ensureEditListener();
  editHandlers.set(messageId, handler);
  return () => {
    if (editHandlers.get(messageId) === handler) editHandlers.delete(messageId);
  };
}

export function onFocusComposer(handler: (detail: FocusComposerDetail) => void): () => void {
  const listener = (e: Event) => {
    const ce = e as CustomEvent<FocusComposerDetail | undefined>;
    if (ce.detail) handler(ce.detail);
  };
  window.addEventListener(WINDOW_EVENTS.FocusComposer, listener);
  return () => window.removeEventListener(WINDOW_EVENTS.FocusComposer, listener);
}
