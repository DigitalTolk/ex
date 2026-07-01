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
      const { message, variant } = (e as CustomEvent<ToastDetail>).detail;
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, variant }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_TTL_MS);
    };
    window.addEventListener(TOAST_EVENT, handler);
    return () => window.removeEventListener(TOAST_EVENT, handler);
  }, []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          data-variant={t.variant}
          className={`pointer-events-auto max-w-sm rounded-lg border px-4 py-2 text-sm shadow-lg ${
            t.variant === 'error'
              ? 'border-destructive/40 bg-card text-destructive'
              : 'border-border bg-card text-foreground'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}
