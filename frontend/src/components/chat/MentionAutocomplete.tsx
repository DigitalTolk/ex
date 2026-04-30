import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAllUsers } from '@/hooks/useConversations';
import { usePresence } from '@/context/PresenceContext';
import { fuzzyMatch } from '@/lib/fuzzy';
import { topK } from '@/lib/topk';
import { getInitials } from '@/lib/format';

// MentionSuggestion is the shape the editor inserts. user => @[id|name]
// pill; group => literal "@all"/"@here" text. `online` is a UI flag —
// resolved at memo time from the live presence state.
export type MentionSuggestion =
  | { kind: 'user'; id: string; displayName: string; email?: string; avatarURL?: string; online?: boolean }
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

type GroupName = 'all' | 'here';

const GROUP_DESCRIPTIONS: Record<GroupName, string> = {
  all: 'Notify everyone in this channel',
  here: 'Notify everyone currently online',
};
const GROUP_NAMES: GroupName[] = ['all', 'here'];

// Cap the rendered list so a large workspace doesn't render a giant
// popup on an empty query. Filtering is cheap; rendering isn't.
const MAX_RESULTS = 12;

export function MentionAutocomplete({ query, anchorRect, onPick, onDismiss }: Props) {
  const { data: users } = useAllUsers();
  const { isOnline } = usePresence();
  const [active, setActive] = useState(0);

  const q = useMemo(() => query.trim().toLowerCase(), [query]);

  // Roster filter is stable across presence changes — we only re-run
  // the fuzzy match when the roster or query actually changes. A
  // teammate going online doesn't re-walk hundreds of users.
  const filteredUsers = useMemo(
    () => (users ?? []).filter((u) => fuzzyMatch(q, u.displayName, u.email)),
    [users, q],
  );

  // @here / @all are noisy — surface them only when the user has
  // typed the group name out in full. Plain `@` and partial typing
  // skip past them straight to the user roster (online first).
  const items: MentionSuggestion[] = useMemo(() => {
    const groupItems: MentionSuggestion[] = GROUP_NAMES
      .filter((name) => name === q)
      .map((name) => ({ kind: 'group', group: name }));
    // Online first, then alphabetical. topK is a single-pass selection
    // so we never sort the trailing N-K users; the popup caps at
    // MAX_RESULTS rendered rows anyway.
    const top = topK(filteredUsers, MAX_RESULTS, (a, b) => {
      const ao = isOnline(a.id);
      const bo = isOnline(b.id);
      if (ao !== bo) return ao ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    const userItems: MentionSuggestion[] = top.map((u) => ({
      kind: 'user',
      id: u.id,
      displayName: u.displayName,
      email: u.email,
      avatarURL: u.avatarURL,
      online: isOnline(u.id),
    }));
    return [...groupItems, ...userItems];
  }, [filteredUsers, q, isOnline]);

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
      className="w-[28rem] max-w-[90vw] rounded-md border bg-popover p-1 shadow-lg"
    >
      {items.map((it, i) => (
        <button
          key={it.kind === 'user' ? `u-${it.id}` : `g-${it.group}`}
          type="button"
          role="option"
          aria-selected={i === active}
          data-testid="mention-option"
          data-mention-active={i === active ? 'true' : 'false'}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(it);
          }}
          onMouseEnter={() => setActive(i)}
          className={
            'flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-sm ' +
            (i === active ? 'bg-muted' : 'hover:bg-muted/50')
          }
        >
          {it.kind === 'user' ? <UserRow it={it} /> : <GroupRow it={it} />}
        </button>
      ))}
    </div>
  );
}

function UserRow({ it }: { it: Extract<MentionSuggestion, { kind: 'user' }> }) {
  return (
    <>
      <span className="relative shrink-0">
        <Avatar className="h-7 w-7">
          {it.avatarURL && <AvatarImage src={it.avatarURL} alt="" />}
          <AvatarFallback className="bg-primary/10 text-xs">
            {getInitials(it.displayName)}
          </AvatarFallback>
        </Avatar>
        {it.online && (
          <span
            data-testid="mention-online-indicator"
            aria-label="Online"
            className="absolute right-0 bottom-0 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-popover"
          />
        )}
      </span>
      <span className="truncate font-medium">{it.displayName}</span>
      {it.email && (
        <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
          {it.email}
        </span>
      )}
    </>
  );
}

function GroupRow({ it }: { it: Extract<MentionSuggestion, { kind: 'group' }> }) {
  return (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold">
        @
      </span>
      <span className="font-medium">@{it.group}</span>
      <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
        {GROUP_DESCRIPTIONS[it.group]}
      </span>
    </>
  );
}
