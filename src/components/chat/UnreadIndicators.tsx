import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { sinceLabel } from '@/lib/unread-marker';

// Unread chrome for the message list (Slack/Discord pattern): the "New" line
// above the first unread message, the top banner that jumps back to it, and
// the bottom pill for messages that arrived while scrolled up. All three use
// the `brand` token — the design system's colour for unread.

function plural(n: number): string {
  return `${n} new message${n === 1 ? '' : 's'}`;
}

export type DividerPosition = 'above' | 'visible' | 'below';

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="textbox"]';
const OVERLAY_SELECTOR = '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-testid="popover-portal"]';

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(EDITABLE_SELECTOR);
}

function hasOpenOverlay(): boolean {
  return !!document.querySelector(OVERLAY_SELECTOR);
}

// UnreadDividerRow reports where it sits relative to the scroller viewport so
// the banner shows only while the first unread is above the reader.
export function UnreadDividerRow({
  root,
  onPosition,
}: {
  root: HTMLElement | null;
  onPosition: (position: DividerPosition) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    /* istanbul ignore next -- the ref is attached on the element this effect's component renders, so it is always set by the time the effect runs */
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (legacy env): treat the divider as seen so the banner
      // never sticks around with no way to resolve it.
      onPosition('visible');
      return;
    }
    // Wait for the real scroller: a null root observes against the document
    // viewport, which misplaces a divider above the list's top edge.
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onPosition('visible');
            continue;
          }
          // Measure the node itself rather than trusting
          // entry.boundingClientRect: WebKit (iOS Safari) reports a stale
          // rect for a non-intersecting target, which put a divider BELOW
          // the viewport "above" it — showing the jump-up banner for
          // messages that are actually below the reader.
          const above = node.getBoundingClientRect().bottom <= root.getBoundingClientRect().top;
          onPosition(above ? 'above' : 'below');
        }
      },
      { root },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [root, onPosition]);
  return (
    <div
      ref={ref}
      data-testid="unread-divider"
      className="flex items-center gap-2 px-4 py-1"
      role="separator"
      aria-label="New messages"
    >
      <div className="flex-1 border-t border-brand" />
      <span className="text-xs font-semibold text-brand">New</span>
    </div>
  );
}

export function UnreadBanner({
  count,
  since,
  onJump,
  onDismiss,
}: {
  count: number;
  since?: string;
  onJump: () => void;
  onDismiss: () => void;
}) {
  // Esc dismisses (and marks read), Slack-style — but ONLY when the key isn't
  // meant for something else, because dismissing reads the channel:
  //  - focus in any editable (composer, search, inline edits) → not ours;
  //  - an overlay open at key time (dialog, lightbox, menu, listbox,
  //    popover) → not ours;
  //  - any handler claimed it (preventDefault) — checked AFTER the event has
  //    finished dispatching, since listener order across window/document is
  //    not something to rely on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditableTarget(e.target) || hasOpenOverlay()) return;
      window.setTimeout(() => {
        if (!e.defaultPrevented) onDismiss();
      }, 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);
  return (
    <div
      data-testid="unread-banner"
      className="absolute inset-x-2 top-2 z-10 flex items-center overflow-hidden rounded-md bg-brand text-sm text-brand-foreground shadow-md"
      role="status"
    >
      <button
        type="button"
        onClick={onJump}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left hover:bg-brand-hover"
      >
        <ArrowUp className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">Jump to new messages</span>
        <span className="ml-auto truncate opacity-90">
          {plural(count)}
          {sinceLabel(since)}
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Mark as read"
        title="Mark as read (Esc)"
        className="shrink-0 px-2 py-1.5 hover:bg-brand-hover"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function NewMessagesPill({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="new-messages-pill"
      onClick={onClick}
      className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground shadow-md hover:bg-brand-hover"
    >
      <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
      {plural(count)}
    </button>
  );
}
