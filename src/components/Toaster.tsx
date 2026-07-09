import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TOAST_EVENT, type ToastDetail } from '@/lib/toast';

interface Toast extends ToastDetail {
  id: number;
}

// How long a toast stays before auto-dismissing.
const TOAST_TTL_MS = 4000;

// Toaster listens for TOAST_EVENT and renders transient messages bottom-center,
// each auto-dismissing after TOAST_TTL_MS. Mounted once at the app root.
export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, ...detail }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_TTL_MS);
    };
    window.addEventListener(TOAST_EVENT, handler);
    return () => window.removeEventListener(TOAST_EVENT, handler);
  }, []);

  if (toasts.length === 0) return null;

  const renderToast = (t: Toast) => {
    const body = (
      <>
        {t.title && <span className="block font-semibold">{t.title}</span>}
        {t.message}
      </>
    );
    // Notification banners use their own distinct palette (faint amber-yellow
    // in light, warm near-black in dark — see the --color-notification-toast
    // tokens) so they NEVER blend into the surface they cover, and are always
    // a fixed WIDE box (w-full up to max-w-md) so the banner doesn't jump
    // around sizing itself to each message's length. Plain toasts keep the
    // subtle card look and hug their content next to the action that raised them.
    const boxClass = `pointer-events-auto rounded-lg border px-4 py-2 text-sm ${
      t.kind === 'notification'
        ? 'w-full max-w-md border-notification-toast-border bg-notification-toast text-notification-toast-foreground shadow-xl'
        : t.variant === 'error'
          ? 'max-w-sm border-destructive/40 bg-card text-destructive shadow-lg'
          : 'max-w-sm border-border bg-card text-foreground shadow-lg'
    }`;
    // A toast with an action (e.g. a notification deep-link) is a real
    // button: tapping it runs the action and dismisses immediately.
    return t.onActivate ? (
      <button
        key={t.id}
        type="button"
        data-testid="toast"
        data-variant={t.variant}
        data-kind={t.kind}
        className={`${boxClass} text-left`}
        onClick={() => {
          t.onActivate?.();
          setToasts((prev) => prev.filter((x) => x.id !== t.id));
        }}
      >
        {body}
      </button>
    ) : (
      <div key={t.id} data-testid="toast" data-variant={t.variant} data-kind={t.kind} className={boxClass}>
        {body}
      </div>
    );
  };

  const banners = toasts.filter((t) => t.kind === 'notification');
  const plain = toasts.filter((t) => t.kind !== 'notification');

  return createPortal(
    <>
      {banners.length > 0 && (
        <div
          // Notification banners drop from the TOP, OS-style, clearing the
          // notch/status bar. Same z-[1100] rationale as below.
          className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[1100] flex flex-col items-center gap-2 px-4"
          role="status"
          aria-live="polite"
        >
          {banners.map(renderToast)}
        </div>
      )}
      {plain.length > 0 && (
        <div
          // z-[1100]: above the lightbox (100), the mobile action sheet (120)
          // and the body-portalled popovers/typeahead (1000) — a transient
          // toast must never be buried under whatever overlay happens to be
          // open. Bottom offset clears the home indicator on notched phones.
          className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-[1100] flex flex-col items-center gap-2 px-4"
          role="status"
          aria-live="polite"
        >
          {plain.map(renderToast)}
        </div>
      )}
    </>,
    document.body,
  );
}
