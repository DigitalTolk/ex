import { useEffect, useMemo, useRef, useState } from 'react';
import { useBrowseChannels } from '@/hooks/useChannels';
import { fuzzyMatch } from '@/lib/fuzzy';

// Channel autocomplete pick payload — id is what gets stamped into the
// markdown so the link survives renames; slug is what the user reads.
export interface ChannelSuggestion {
  id: string;
  slug: string;
  name: string;
}

interface Props {
  query: string;
  anchorRect: DOMRect | null;
  onPick: (s: ChannelSuggestion) => void;
  onDismiss: () => void;
}

const MAX_ROWS = 8;

export function ChannelAutocomplete({ query, anchorRect, onPick, onDismiss }: Props) {
  // useBrowseChannels already returns the workspace public channel list;
  // filtering is local so a 2-char query doesn't flap the popup while a
  // network request is in flight.
  const { data: all } = useBrowseChannels();
  const [active, setActive] = useState(0);

  const items: ChannelSuggestion[] = useMemo(() => {
    const list = (all ?? [])
      .filter((c) => c.type === 'public' && !c.archived)
      .filter((c) => fuzzyMatch(query, c.slug, c.name))
      .slice(0, MAX_ROWS)
      .map((c) => ({ id: c.id, slug: c.slug, name: c.name }));
    return list;
  }, [all, query]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(0);
  }, [items.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (items.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        onPick(items[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
        return;
      }
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [items, active, onPick, onDismiss]);

  const popupRef = useRef<HTMLDivElement>(null);
  const style: React.CSSProperties = anchorRect
    ? {
        position: 'fixed',
        left: Math.max(8, anchorRect.left),
        bottom: Math.max(8, window.innerHeight - anchorRect.top + 4),
        zIndex: 60,
      }
    : { display: 'none' };

  if (items.length === 0) return null;

  return (
    <div
      ref={popupRef}
      data-testid="channel-popup"
      role="listbox"
      aria-label="Channel suggestions"
      style={style}
      className="w-[24rem] max-w-[90vw] rounded-md border bg-popover p-1 shadow-lg"
    >
      {items.map((c, i) => {
        const isActive = i === active;
        return (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={isActive}
            data-testid="channel-option"
            data-channel-active={isActive ? 'true' : 'false'}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            onMouseEnter={() => setActive(i)}
            className={
              'flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-sm ' +
              (isActive ? 'bg-muted' : 'hover:bg-muted/50')
            }
          >
            <span className="truncate font-medium">~{c.slug}</span>
            {c.name && c.name !== c.slug && (
              <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                {c.name}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
