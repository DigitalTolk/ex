import { useEffect, useMemo, useRef, useState } from 'react';
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

// BucketPicker turns OpenSearch terms-aggregation buckets into a
// dropdown of filter options. The list is the *result-set facet* — only
// users/parents that actually appear in the current hits show up, so
// picking one always returns hits.
export function BucketPicker({ kind, buttonLabel, buckets, onPick }: BucketPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

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
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        data-testid={`bucket-picker-${kind}`}
        onClick={() => setOpen((p) => !p)}
        className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
      >
        {buttonLabel}
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg"
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
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
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
        </div>
      )}
    </div>
  );
}
