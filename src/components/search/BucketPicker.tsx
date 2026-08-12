import { useMemo, useRef, useState } from 'react';
import { PopoverPortal } from '@/components/PopoverPortal';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import type { AggBucket } from '@/hooks/useSearch';

interface BucketPickerProps {
  kind: 'users' | 'channels';
  buttonLabel: string;
  buckets: AggBucket[];
  onPick: (id: string) => void;
}

// w-64 plus the max-h-64 list — the portal only needs these to pick a side
// before it has measured the real panel.
const BUCKET_LIST_WIDTH = 256;
const BUCKET_LIST_HEIGHT = 256;

// BucketPicker turns OpenSearch terms-aggregation buckets into a
// dropdown of filter options. The list is the *result-set facet* — only
// users/parents that actually appear in the current hits show up, so
// picking one always returns hits.
export function BucketPicker({ kind, buttonLabel, buckets, onPick }: BucketPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const ids = useMemo(() => buckets.map((b) => b.key), [buckets]);
  const { data: users = [] } = useUsersBatch(kind === 'users' ? ids : []);
  const { data: userChannels = [] } = useUserChannels();
  const { data: userConvs = [] } = useUserConversations();

  const labelFor = (id: string): string => {
    if (kind === 'users') {
      return users.find((u) => u.id === id)?.displayName ?? id;
    }
    const ch = userChannels.find((c) => c.channelID === id);
    if (ch) return `~${ch.channelName}`;
    const conv = userConvs.find((c) => c.conversationID === id);
    return conv?.displayName ?? id;
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={`bucket-picker-${kind}`}
        onClick={() => setOpen((p) => !p)}
        className="inline-flex h-auto items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted mobile:h-9 mobile:px-3 mobile:text-sm"
      >
        {buttonLabel}
      </button>
      {/* PopoverPortal rather than a hand-rolled `absolute left-0 w-64`: these
          chips sit in a wrapping filter row, so on a phone the second one is
          already past the halfway mark and a left-anchored 256px panel ran
          straight off the right edge. The portal clamps to the viewport (and
          brings outside-click / Escape / Android-back dismissal with it,
          which this component used to hand-roll for the mouse case only). */}
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={() => setOpen(false)}
        role="listbox"
        ariaLabel={buttonLabel}
        estimatedWidth={BUCKET_LIST_WIDTH}
        estimatedHeight={BUCKET_LIST_HEIGHT}
        className="w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg"
      >
        {buckets.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No options for the current results.
          </p>
        ) : (
          <ul className="max-h-64 overflow-y-auto">
            {buckets.map((b) => (
              <li key={b.key}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(b.key);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted mobile:py-3 mobile:text-base"
                >
                  <span className="truncate">{labelFor(b.key)}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {b.count}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverPortal>
    </>
  );
}
