import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { animate, motion, useMotionValue } from 'motion/react';
import { useDrag } from '@use-gesture/react';
import { Button } from '@/components/ui/button';
import { SWIPE_SPRING, shouldCommitSwipe } from '@/lib/swipe';
import { TOAST_EVENT, type ToastDetail } from '@/lib/toast';

interface Toast extends ToastDetail {
  id: number;
  // Messages this banner stands for (grouped notifications).
  count: number;
}

// How long a toast stays before auto-dismissing. A grouped banner starts
// over with each new message.
const TOAST_TTL_MS = 4000;

// Toaster listens for TOAST_EVENT and renders transient messages bottom-center,
// each auto-dismissing after TOAST_TTL_MS. Mounted once at the app root.
export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // Notification group → the banner showing it.
  const groups = useRef(new Map<string, number>());

  // Banners under a finger: they wait until it lifts.
  const held = useRef(new Set<number>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    held.current.delete(id);
    for (const [group, groupId] of groups.current) {
      if (groupId === id) groups.current.delete(group);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // (Re)starts a toast's time on screen, unless it is being held.
  const schedule = useCallback(
    (id: number) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      if (!held.current.has(id)) timers.current.set(id, setTimeout(() => dismiss(id), TOAST_TTL_MS));
    },
    [dismiss],
  );

  const hold = useCallback(
    (id: number, on: boolean) => {
      if (on) held.current.add(id);
      else held.current.delete(id);
      schedule(id);
    },
    [schedule],
  );

  useEffect(() => {
    const pending = timers.current;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      const group = detail.kind === 'notification' ? detail.group : undefined;
      const existing = group === undefined ? undefined : groups.current.get(group);
      const id = existing ?? nextId.current++;
      if (group !== undefined) groups.current.set(group, id);
      setToasts((prev) =>
        existing === undefined
          ? [...prev, { id, ...detail, count: 1 }]
          : prev.map((t) => (t.id === id ? { ...t, ...detail, count: t.count + 1 } : t)),
      );
      schedule(id);
    };
    window.addEventListener(TOAST_EVENT, handler);
    return () => {
      window.removeEventListener(TOAST_EVENT, handler);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, [schedule]);

  if (toasts.length === 0) return null;

  const renderToast = (t: Toast) => {
    const body = (
      <>
        {t.title && <span className="block font-semibold">{t.title}</span>}
        {t.message}
      </>
    );
    // Plain toasts keep the subtle card look and hug their content next to
    // the action that raised them.
    const boxClass = `pointer-events-auto rounded-lg border px-4 py-2 text-sm max-w-sm bg-card shadow-lg ${
      t.variant === 'error' ? 'border-destructive/40 text-destructive' : 'border-border text-foreground'
    }`;
    // A toast with an action is a real button: tapping it runs the action
    // and dismisses immediately.
    return t.onActivate ? (
      <button
        key={t.id}
        type="button"
        data-testid="toast"
        data-variant={t.variant}
        className={`${boxClass} text-left`}
        onClick={() => {
          t.onActivate?.();
          dismiss(t.id);
        }}
      >
        {body}
      </button>
    ) : (
      <div key={t.id} data-testid="toast" data-variant={t.variant} className={boxClass}>
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
          {banners.map((t) => (
            <NotificationBanner key={t.id} toast={t} onDismiss={() => dismiss(t.id)} onHold={(on) => hold(t.id, on)} />
          ))}
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

// A notification banner. Notification banners use their own distinct palette
// (faint amber-yellow in light, warm near-black in dark — see the
// --color-notification-toast tokens) so they NEVER blend into the surface they
// cover, and are always a fixed WIDE box (w-full up to max-w-md) so the banner
// doesn't jump around sizing itself to each message's length. Tapping the
// message opens it. Swiping it up or to either side puts it away, as a
// phone's own banners go; a mouse has the X instead.
function NotificationBanner({
  toast: t,
  onDismiss,
  onHold,
}: {
  toast: Toast;
  onDismiss: () => void;
  // A banner under a finger stays until the finger lifts.
  onHold: (held: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  // A drag ends in a click on the message; that click opens nothing.
  const dragged = useRef(false);
  const bind = useDrag(
    ({ first, last, tap, axis, movement: [mx, my], velocity: [vx, vy], direction: [dx, dy] }) => {
      if (tap) return;
      if (first) dragged.current = true;
      const sideways = axis === 'x';
      if (!last) {
        if (sideways) x.set(mx);
        else y.set(Math.min(0, my));
        return;
      }
      const box = ref.current!.getBoundingClientRect();
      const gone = sideways
        ? shouldCommitSwipe({ distance: Math.abs(mx), velocity: Math.sign(mx) * dx * vx * 1000, travel: box.width })
        : shouldCommitSwipe({ distance: -my, velocity: -dy * vy * 1000, travel: box.bottom });
      if (!gone) {
        void animate(sideways ? x : y, 0, SWIPE_SPRING);
        return;
      }
      const away = sideways ? Math.sign(mx) * window.innerWidth : -box.bottom - 16;
      void animate(sideways ? x : y, away, { duration: 0.18 }).then(onDismiss);
    },
    // Moves are followed on the window; arrow keys are not a swipe.
    { axis: 'lock', filterTaps: true, pointer: { capture: false, keys: false } },
  );
  const { onPointerDown } = bind();
  const holdUntilLift = () => {
    onHold(true);
    const ends = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'];
    const lift = () => {
      for (const type of ends) window.removeEventListener(type, lift);
      onHold(false);
    };
    for (const type of ends) window.addEventListener(type, lift);
  };
  const body = (
    <>
      {(t.title || t.count > 1) && (
        <span className="flex items-baseline gap-2">
          {t.title && <span className="min-w-0 truncate font-semibold">{t.title}</span>}
          {t.count > 1 && (
            <span className="ml-auto shrink-0 text-xs" data-testid="toast-count">
              {t.count} messages
            </span>
          )}
        </span>
      )}
      <span className="block break-words">{t.message}</span>
    </>
  );
  const bodyClass = 'min-w-0 flex-1 px-4 py-2 text-left';
  return (
    <motion.div
      ref={ref}
      onPointerDown={(e) => {
        holdUntilLift();
        onPointerDown?.(e);
      }}
      style={{ x, y }}
      data-testid="toast"
      data-variant={t.variant}
      data-kind="notification"
      // touch-none: the finger moves the banner, not the page under it.
      className="pointer-events-auto flex w-full max-w-md touch-none items-start rounded-lg border border-notification-toast-border bg-notification-toast text-sm text-notification-toast-foreground shadow-xl select-none"
    >
      {t.onActivate ? (
        <button
          type="button"
          className={bodyClass}
          data-testid="toast-open"
          onPointerDown={() => {
            dragged.current = false;
          }}
          onClick={() => {
            if (dragged.current) return;
            t.onActivate?.();
            onDismiss();
          }}
        >
          {body}
        </button>
      ) : (
        <div className={bodyClass}>{body}</div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="mt-1 mr-1 shrink-0 text-current hover:bg-notification-toast-border/50 touch:hidden"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="h-4 w-4" />
      </Button>
    </motion.div>
  );
}
