import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

// Once the line has been in view this long it has done its job: it fades and
// `onSeen` retires it (the anchor is cleared, so the banner/pill go too).
const UNREAD_DIVIDER_LINGER_MS = 3000;
const UNREAD_DIVIDER_FADE_MS = 500;

// UnreadDivider is the "New messages" line above the first unread message:
// centred like the day divider, in red, and inset so it starts and ends
// where the messages do rather than running to the edges. The default inset
// lines it up with the main list's avatars (row px-4 + item px-3 = 28px);
// the thread panel passes its own. With `onSeen`, the line fades out 3s
// after it comes into view and then reports it; the owner then renders it
// `retired` — same box, invisible — so the rows around it never move.
export function UnreadDivider({
  inset = 'px-7',
  onSeen,
  retired = false,
}: {
  inset?: string;
  onSeen?: () => void;
  retired?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fading, setFading] = useState(false);
  const onSeenRef = useRef(onSeen);
  useEffect(() => {
    onSeenRef.current = onSeen;
  });
  const watches = !!onSeen && !retired;
  useEffect(() => {
    const el = ref.current;
    if (!el || !watches || typeof IntersectionObserver === 'undefined') return;
    let linger = 0;
    let fade = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || linger) return;
      observer.disconnect();
      linger = window.setTimeout(() => {
        setFading(true);
        fade = window.setTimeout(() => onSeenRef.current?.(), UNREAD_DIVIDER_FADE_MS);
      }, UNREAD_DIVIDER_LINGER_MS);
    }, { threshold: 0.5 });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(linger);
      window.clearTimeout(fade);
    };
  }, [watches]);
  return (
    <div
      ref={ref}
      data-testid="unread-divider"
      data-unread-divider=""
      data-retired={retired ? 'true' : undefined}
      className={`flex items-center gap-3 py-1 transition-opacity duration-500 ${fading || retired ? 'opacity-0' : ''} ${retired ? 'invisible' : ''} ${inset}`}
      role="separator"
      aria-label="New messages"
      aria-hidden={retired || undefined}
    >
      <div className="flex-1 border-t border-destructive/60" />
      <span className="shrink-0 text-xs font-semibold text-destructive">New messages</span>
      <div className="flex-1 border-t border-destructive/60" />
    </div>
  );
}

function plural(n: number): string {
  return `${n} new message${n === 1 ? '' : 's'}`;
}

interface UnreadBannerProps {
  count: number;
  onJump: () => void;
  onMarkRead: () => void;
}

// UnreadBanner sits over the top of the list while the first unread message
// is scrolled out of view above: jump back to it, or mark it all read.
export function UnreadBanner({ count, onJump, onMarkRead }: UnreadBannerProps) {
  return (
    <div
      data-testid="unread-banner"
      className="absolute inset-x-3 top-2 z-10 flex items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-1.5 text-sm shadow-sm backdrop-blur"
    >
      <button
        type="button"
        onClick={onJump}
        data-testid="unread-banner-jump"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium"
      >
        <ArrowUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{plural(count)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">Jump</span>
      </button>
      <button
        type="button"
        onClick={onMarkRead}
        data-testid="unread-banner-mark-read"
        className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
      >
        Mark as read
      </button>
    </div>
  );
}

// NewBelowPill floats over the bottom of the list while unread messages sit
// below the viewport (they arrived while the user was scrolled up).
export function NewBelowPill({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="unread-below-pill"
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-sm font-medium shadow-md"
    >
      <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
      {plural(count)}
    </button>
  );
}
