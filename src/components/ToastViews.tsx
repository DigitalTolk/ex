import { useRef } from 'react';
import { X } from 'lucide-react';
import { animate, motion, useMotionValue } from 'motion/react';
import { useDrag } from '@use-gesture/react';
import { Button } from '@/components/ui/button';
import { SWIPE_SPRING, shouldCommitSwipe } from '@/lib/swipe';
import type { ToastVariant } from '@/lib/toast';

// What a toast shows. sonner (mounted by <Toaster/>) places, stacks, times and
// removes them; these are the surfaces it renders through toast.custom.

interface ToastContent {
  message: string;
  variant: ToastVariant;
  // Optional bold first line (e.g. a notification's "Alice in ~general").
  title?: string;
  // When set, the toast is tappable and runs this before going away.
  onActivate?: () => void;
  onDismiss: () => void;
}

// A plain toast keeps the subtle card look and hugs its content next to the
// action that raised it. One with an action is a real button: tapping it runs
// the action and puts the toast away at once.
export function PlainToast({ message, variant, title, onActivate, onDismiss }: ToastContent) {
  const body = (
    <>
      {title && <span className="block font-semibold">{title}</span>}
      {message}
    </>
  );
  const boxClass = `pointer-events-auto rounded-lg border px-4 py-2 text-sm max-w-sm bg-card shadow-lg ${
    variant === 'error' ? 'border-destructive/40 text-destructive' : 'border-border text-foreground'
  }`;
  return (
    // The slot sonner gives a toast is a fixed width; the card sits centred in
    // it, and the slot itself lets taps through to the page.
    <div className="pointer-events-none flex justify-center">
      {onActivate ? (
        <button
          type="button"
          data-testid="toast"
          data-variant={variant}
          className={`${boxClass} text-left`}
          onClick={() => {
            onActivate();
            onDismiss();
          }}
        >
          {body}
        </button>
      ) : (
        <div data-testid="toast" data-variant={variant} className={boxClass}>
          {body}
        </div>
      )}
    </div>
  );
}

// A notification banner: the in-app popup surface for webviews without a
// Notification API. It uses its own palette (faint amber-yellow in light,
// warm near-black in dark — the --color-notification-toast tokens) so it
// NEVER blends into the surface it covers, and is always a fixed WIDE box
// (w-full up to max-w-md) so it doesn't jump around sizing itself to each
// message. Tapping the message opens it. Swiping it up or to either side puts
// it away, as a phone's own banners go (the app's shared swipe model, see
// lib/swipe); a mouse has the X instead.
export function NotificationBanner({
  message,
  variant,
  title,
  onActivate,
  onDismiss,
  count,
  onHold,
}: ToastContent & {
  // Messages this banner stands for (grouped notifications).
  count: number;
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
      {(title || count > 1) && (
        <span className="flex items-baseline gap-2">
          {title && <span className="min-w-0 truncate font-semibold">{title}</span>}
          {count > 1 && (
            <span className="ml-auto shrink-0 text-xs" data-testid="toast-count">
              {count} messages
            </span>
          )}
        </span>
      )}
      <span className="block break-words">{message}</span>
    </>
  );
  const bodyClass = 'min-w-0 flex-1 px-4 py-2 text-left';
  return (
    <motion.div
      ref={ref}
      onPointerDown={(e) => {
        holdUntilLift();
        onPointerDown?.(e);
        // This banner keeps its own time while held (onHold); the press must
        // not also pause the whole stack, which only a release over the stack
        // would resume.
        e.stopPropagation();
      }}
      style={{ x, y }}
      data-testid="toast"
      data-variant={variant}
      data-kind="notification"
      // touch-none: the finger moves the banner, not the page under it.
      className="pointer-events-auto flex w-full max-w-md touch-none items-start rounded-lg border border-notification-toast-border bg-notification-toast text-sm text-notification-toast-foreground shadow-xl select-none"
    >
      {onActivate ? (
        <button
          type="button"
          className={bodyClass}
          data-testid="toast-open"
          onPointerDown={() => {
            dragged.current = false;
          }}
          onClick={() => {
            if (dragged.current) return;
            onActivate();
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
