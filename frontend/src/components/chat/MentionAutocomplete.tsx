import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchUsers } from '@/hooks/useConversations';

// MentionSuggestion is the shape the editor inserts. user => @[id|name]
// pill; group => literal "@all"/"@here" text.
export type MentionSuggestion =
  | { kind: 'user'; id: string; displayName: string; email?: string }
  | { kind: 'group'; group: 'all' | 'here' };

interface Props {
  // Text the user typed after the @ (lowercased for matching).
  query: string;
  // Anchor for positioning — the mention popup appears just above the
  // caret so the user keeps reading downward as they type.
  anchorRect: DOMRect | null;
  // Pick a suggestion (Enter / Tab / click). The editor inserts the pill
  // and replaces the trigger range.
  onPick: (s: MentionSuggestion) => void;
  // Esc / lose focus — caller closes the popup.
  onDismiss: () => void;
}

const GROUPS: { kind: 'group'; group: 'all' | 'here'; description: string }[] = [
  { kind: 'group', group: 'all', description: 'Notify everyone in this channel' },
  { kind: 'group', group: 'here', description: 'Notify everyone currently online' },
];

export function MentionAutocomplete({ query, anchorRect, onPick, onDismiss }: Props) {
  const { data: users } = useSearchUsers(query);
  const [active, setActive] = useState(0);

  // Group entries first (Slack-style); then user matches. When the query
  // is non-empty, group entries also need to be filtered so typing
  // "alice" doesn't keep "@all" at the top of the list.
  const items: MentionSuggestion[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groupItems: MentionSuggestion[] = GROUPS
      .filter((g) => g.group.startsWith(q) || q.length === 0)
      .map((g) => ({ kind: 'group', group: g.group }));
    const userItems: MentionSuggestion[] = (users ?? []).map((u) => ({
      kind: 'user',
      id: u.id,
      displayName: u.displayName,
      email: u.email,
    }));
    return [...groupItems, ...userItems];
  }, [query, users]);

  // Reset the highlighted index when the suggestion list changes — the
  // previous highlighted row may no longer exist after a query refines.
  // This is a deliberate sync from a derived input (items.length) into
  // local UI state, hence the lint suppression.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(0);
  }, [items.length]);

  // Keyboard handling lives at this level — the editor surrenders Enter,
  // ArrowUp/Down, Escape to us as long as the popup is open.
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
  // Position above the caret so the typed @ remains visible.
  const style: React.CSSProperties = anchorRect
    ? {
        position: 'fixed',
        left: Math.max(8, anchorRect.left),
        bottom: Math.max(8, window.innerHeight - anchorRect.top + 4),
        zIndex: 60,
      }
    : { display: 'none' };

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      ref={popupRef}
      data-testid="mention-popup"
      role="listbox"
      aria-label="Mention suggestions"
      style={style}
      className="w-72 rounded-md border bg-popover p-1 shadow-lg"
    >
      {items.map((it, i) => {
        const isActive = i === active;
        const key = it.kind === 'user' ? `u-${it.id}` : `g-${it.group}`;
        const label = it.kind === 'user' ? `@${it.displayName}` : `@${it.group}`;
        const sub =
          it.kind === 'user'
            ? it.email
            : it.group === 'all'
              ? 'Notify everyone in this channel'
              : 'Notify everyone currently online';
        return (
          <button
            key={key}
            type="button"
            role="option"
            aria-selected={isActive}
            data-testid="mention-option"
            data-mention-active={isActive ? 'true' : 'false'}
            onMouseDown={(e) => {
              // Prevent the contentEditable from losing focus on click.
              e.preventDefault();
              onPick(it);
            }}
            onMouseEnter={() => setActive(i)}
            className={
              'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm ' +
              (isActive ? 'bg-muted' : 'hover:bg-muted/50')
            }
          >
            <span className="font-medium">{label}</span>
            {sub && <span className="ml-auto truncate text-xs text-muted-foreground">{sub}</span>}
          </button>
        );
      })}
    </div>
  );
}
