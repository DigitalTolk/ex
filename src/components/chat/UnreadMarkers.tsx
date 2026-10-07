import { ArrowDown, ArrowUp } from 'lucide-react';

// UnreadDivider is the "New messages" line above the first unread message.
export function UnreadDivider() {
  return (
    <div
      data-testid="unread-divider"
      data-unread-divider=""
      className="flex items-center gap-3 px-4 py-1"
      role="separator"
      aria-label="New messages"
    >
      <div className="flex-1 border-t border-destructive/70" />
      <span className="text-xs font-semibold text-destructive">New messages</span>
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
