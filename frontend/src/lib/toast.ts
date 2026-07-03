// Minimal app-wide toast: a fire-and-forget helper that dispatches a window
// event, plus a single <Toaster/> (mounted once) that listens and renders. Using
// a window event (like the app's other window-events) avoids threading a context
// provider through every caller — showToast is a no-op if no Toaster is mounted.

export const TOAST_EVENT = 'app:toast';

export type ToastVariant = 'success' | 'error';

export interface ToastDetail {
  message: string;
  variant: ToastVariant;
  // Optional bold first line (e.g. a notification's "Alice in ~general").
  title?: string;
  // When set, the toast is tappable and runs this (e.g. deep-link into the
  // channel a notification came from) before dismissing.
  onActivate?: () => void;
}

// showToast surfaces a transient message. Defaults to the error variant since the
// main callers are failure paths (e.g. a reminder that couldn't be scheduled).
export function showToast(
  message: string,
  variant: ToastVariant = 'error',
  opts?: Pick<ToastDetail, 'title' | 'onActivate'>,
): void {
  window.dispatchEvent(
    new CustomEvent<ToastDetail>(TOAST_EVENT, { detail: { message, variant, ...opts } }),
  );
}
