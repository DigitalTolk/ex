import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, FileSearch, X, Loader2 } from 'lucide-react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useChannelBySlug } from '@/hooks/useChannels';
import { useUserConversations, useOpenDM } from '@/hooks/useConversations';
import { useSearchUsers, useSearchChannels, type SearchHit } from '@/hooks/useSearch';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ChannelIcon } from '@/components/ChannelIcon';
import { getInitials } from '@/lib/format';
import { isApplePlatform, searchShortcutLabel } from '@/lib/platform';

// ⌘K on Apple platforms, Ctrl K elsewhere. The keydown handler matches the
// SAME platform chord as this hint — on Apple only Cmd+K (a bare Ctrl+K is
// kill-to-end-of-line in text fields and a CodeMirror binding), on other
// platforms only Ctrl+K. The handler re-reads the UA per event (trivial
// regex) so tests can drive both platform branches.
const SEARCH_SHORTCUT_HINT = searchShortcutLabel(navigator.userAgent);

type ScopeKind = 'channel' | 'dm' | 'group';

type Suggestion =
  | { kind: 'all'; label: string }
  | {
      kind: 'in-scope';
      label: string;
      scopeKind: ScopeKind;
      parentId: string;
      parentLabel: string;
    };

// A single activatable row in the unified dropdown. Keyboard nav walks
// this flat, ordered list: channel results → people results → message
// actions. Enter/click dispatches by `kind`.
type Item =
  | { kind: 'channel'; hit: SearchHit }
  | { kind: 'user'; hit: SearchHit }
  | { kind: 'message'; suggestion: Suggestion };

const MIN_SEARCH_CHARS = 2;

// SearchBar — Slack-style unified top search. ⌘K / Ctrl+K focuses it
// from anywhere. Typing ≥2 chars debounce-fetches matching channels
// and people and renders them as sections, followed by a "Search
// messages for <q>" action (plus an in-scope action on a channel/DM
// route). Keyboard nav (ArrowUp/Down + Enter), Escape closes.
//  • Channel row  → navigate to /channel/:slug
//  • Person row   → open/create a DM, navigate to /conversation/:id
//  • Message row  → navigate to /search?q=… (unchanged message flow)
// itemKey gives every dropdown row a stable identity so the highlight can
// survive the item list changing under it (async hits arriving/reordering).
function itemKey(it: Item): string {
  if (it.kind === 'message') {
    return `message:${it.suggestion.kind === 'in-scope' ? `in-${it.suggestion.scopeKind}` : 'all'}`;
  }
  return `${it.kind}:${it.hit.id}`;
}

export function SearchBar() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  // Highlight tracks item IDENTITY, not index — null means "no explicit
  // selection", which resolves to the message-search action. Index-based
  // highlighting made Enter's destination fetch-timing-dependent: channel
  // hits landing just before the keypress would prepend at index 0 and
  // steal an Enter meant for "Search messages for: <q>".
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  const location = useLocation();
  const channelMatch = matchPath('/channel/:id', location.pathname);
  const channelSlug = channelMatch?.params.id;
  const { data: currentChannel } = useChannelBySlug(channelSlug);

  const conversationMatch = matchPath('/conversation/:id', location.pathname);
  const conversationId = conversationMatch?.params.id;
  const { data: userConversations } = useUserConversations();
  const currentConversation = useMemo(
    () =>
      conversationId
        ? userConversations?.find((c) => c.conversationID === conversationId)
        : undefined,
    [conversationId, userConversations],
  );

  const trimmed = q.trim();
  // Entity (channel/people) lookups are debounced so a fast typist
  // doesn't fire a request per keystroke; the message action always
  // reflects the live query so Enter feels instant.
  const debouncedQ = useDebouncedValue(trimmed, 150);
  const searchEnabled = debouncedQ.length >= MIN_SEARCH_CHARS;
  const usersQuery = useSearchUsers(debouncedQ, searchEnabled, 5);
  const channelsQuery = useSearchChannels(debouncedQ, searchEnabled, 5);
  // Hits render only while BOTH the live and the debounced query clear the
  // minimum. keepPreviousData deliberately holds the previous query's hits
  // during a refetch (no flicker mid-typing), but once the input drops
  // below the minimum — or is cleared — those stale rows must neither
  // render nor stay Enter-activatable (backspacing "gen" → "g" used to
  // leave ~general in the hidden item list, and Enter navigated there).
  const hitsEnabled = searchEnabled && trimmed.length >= MIN_SEARCH_CHARS;
  const userHits = useMemo(
    () => (hitsEnabled ? (usersQuery.data?.hits ?? []) : []),
    [hitsEnabled, usersQuery.data],
  );
  const channelHits = useMemo(
    () => (hitsEnabled ? (channelsQuery.data?.hits ?? []) : []),
    [hitsEnabled, channelsQuery.data],
  );
  // The search index can't store avatar URLs (they're short-lived presigned S3
  // links), so resolve fresh avatars for the people hits via the batch endpoint
  // (same pattern as the mention list / activity feed).
  const userHitIDs = useMemo(() => userHits.map((h) => h.id), [userHits]);
  const { map: userAvatarMap } = useUsersBatch(userHitIDs);
  const searching = searchEnabled && (usersQuery.isLoading || channelsQuery.isLoading);

  const { openDM } = useOpenDM();

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trimmed) return [];
    const list: Suggestion[] = [{ kind: 'all', label: trimmed }];
    if (currentChannel) {
      list.push({
        kind: 'in-scope',
        label: trimmed,
        scopeKind: 'channel',
        parentId: currentChannel.id,
        parentLabel: `~${currentChannel.name}`,
      });
    } else if (currentConversation) {
      list.push({
        kind: 'in-scope',
        label: trimmed,
        scopeKind: currentConversation.type === 'group' ? 'group' : 'dm',
        parentId: currentConversation.conversationID,
        parentLabel: currentConversation.displayName,
      });
    }
    return list;
  }, [trimmed, currentChannel, currentConversation]);

  // Flat, ordered list backing keyboard navigation. Channels first,
  // then people, then the message actions.
  const items = useMemo<Item[]>(() => {
    const arr: Item[] = [];
    for (const h of channelHits) arr.push({ kind: 'channel', hit: h });
    for (const h of userHits) arr.push({ kind: 'user', hit: h });
    for (const s of suggestions) arr.push({ kind: 'message', suggestion: s });
    return arr;
  }, [channelHits, userHits, suggestions]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      /* istanbul ignore next -- containerRef is always attached while the dropdown is open; defensive null guard */
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Global ⌘K (Apple) / Ctrl+K (elsewhere) — focus and open the search from
  // anywhere in the app, even while typing in the composer. Strictly the
  // platform chord: the other modifier, Shift/Alt combos (Cmd+Shift+K etc.)
  // and key-repeat are ignored so native text-editing bindings and other
  // shortcuts are never hijacked. Cleaned up on unmount.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const apple = isApplePlatform(navigator.userAgent);
      const chord = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!chord || e.shiftKey || e.altKey || e.repeat) return;
      if (e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Resolve the highlight identity to today's index. A vanished selection
  // (the list shrank or changed) and "no explicit selection" both fall back
  // to the message-search action — the only row whose meaning is stable
  // while fetches are in flight, and the one that always reflects the LIVE
  // query text.
  const defaultIdx = items.findIndex((it) => it.kind === 'message');
  const keyedIdx = highlightKey === null ? -1 : items.findIndex((it) => itemKey(it) === highlightKey);
  const safeHighlight = keyedIdx >= 0 ? keyedIdx : Math.max(defaultIdx, 0);

  function reset() {
    setOpen(false);
    inputRef.current?.blur();
    setQ('');
    setHighlightKey(null);
  }

  function submitSuggestion(sel: Suggestion) {
    const label = sel.label.trim();
    /* istanbul ignore next -- suggestions are built only from non-empty trimmed input (and Enter is gated on the visible dropdown), so a message item always carries a label; defensive */
    if (!label) return;
    const params = new URLSearchParams({ q: label });
    if (sel.kind === 'in-scope') {
      params.set('in', sel.parentId);
      // Land directly on the tab that matches the scope so the user
      // sees the right results immediately, skipping All tab's noise
      // from Channels/People. Channels → "messages"; DMs/groups →
      // "dms" (the DMs tab is filtered to parentType=conversation).
      params.set('type', sel.scopeKind === 'channel' ? 'messages' : 'dms');
    }
    reset();
    navigate(`/search?${params.toString()}`);
  }

  function activate(idx = safeHighlight) {
    /* istanbul ignore next -- safeHighlight is clamped in-range; the ?? fallback and the !item guard are defensive (the dropdown only renders when items is non-empty) */
    const item = items[idx] ?? items[0];
    /* istanbul ignore next -- defensive: activate is only reachable while the dropdown is open, which requires at least one item */
    if (!item) return;
    if (item.kind === 'channel') {
      const slug = String(item.hit._source.slug || item.hit.id);
      reset();
      navigate(`/channel/${slug}`);
    } else if (item.kind === 'user') {
      // reset() only on success: a failed DM-create keeps the typed query
      // and the open dropdown (plus useOpenDM's error toast) so the user
      // can retry instead of facing a silently cleared search box.
      openDM(item.hit.id, { onSuccess: reset });
    } else {
      submitSuggestion(item.suggestion);
    }
  }

  function clear() {
    setQ('');
    inputRef.current?.focus();
  }

  const showDropdown = open && suggestions.length > 0;

  return (
    <div ref={containerRef} className="relative w-full" data-testid="searchbar">
      {/* Rectangular global search per the design — rounded-md corners
          (6px), subtle 1px border, search glyph on the left. On focus
          the field lifts (raised elevation) and widens a touch on
          desktop for a Slack-like focus-expand; the growth is symmetric
          so the centred grid column stays centred, and it's gated to
          md+ so mobile layout is untouched. */}
      <div className="rounded-md transition-all duration-150 focus-within:shadow-lg md:focus-within:-mx-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background dark:bg-muted px-3 text-foreground transition-colors focus-within:border-ring hover:border-border-strong max-md:h-11">
          <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              // Typing re-targets Enter to the message-search action for the
              // NEW text — an arrowed-to selection for the old query must not
              // survive the query changing under it.
              setHighlightKey(null);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              // Enter and the arrows act only on the VISIBLE dropdown — a
              // hidden item list (empty/cleared input) must never be
              // activatable; the old handler navigated to stale hits on
              // Enter with an empty search box.
              if (e.key === 'Enter') {
                e.preventDefault();
                if (showDropdown && items.length > 0) activate();
              } else if (e.key === 'Escape') {
                setOpen(false);
                inputRef.current?.blur();
              } else if (e.key === 'ArrowDown') {
                if (!showDropdown || items.length === 0) return;
                e.preventDefault();
                setHighlightKey(itemKey(items[(safeHighlight + 1) % items.length]));
              } else if (e.key === 'ArrowUp') {
                if (!showDropdown || items.length === 0) return;
                e.preventDefault();
                setHighlightKey(itemKey(items[(safeHighlight - 1 + items.length) % items.length]));
              }
            }}
            placeholder="Search for anything"
            aria-label="Search"
            // Suppress native browser autofill / password-manager / spellcheck
            // overlays — this is our own autocomplete, so a system dropdown on
            // top of it is just noise. type="text" (not "search") avoids the
            // browser's search-history popup too.
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none max-md:text-base"
            data-testid="searchbar-input"
          />
          <kbd className="hidden items-center gap-0.5 rounded border border-border-strong px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground md:inline-flex">
            {SEARCH_SHORTCUT_HINT}
          </kbd>
          {q && (
            <button
              type="button"
              onClick={clear}
              aria-label="Clear search"
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {showDropdown && (
        <div
          role="listbox"
          data-testid="searchbar-dropdown"
          // Match the focus-expanded input width: the input row widens by -mx-2
          // on md+ while focused, and the dropdown only ever shows while focused,
          // so mirror that same negative margin here so their edges line up.
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg md:-mx-2"
        >
          {channelHits.length > 0 && (
            <div role="group" aria-label="Channels">
              <SectionHeader>Channels</SectionHeader>
              {channelHits.map((hit) => {
                const flatIndex = items.findIndex(
                  (it) => it.kind === 'channel' && it.hit.id === hit.id,
                );
                return (
                  <ChannelRow
                    key={hit.id}
                    hit={hit}
                    highlighted={flatIndex === safeHighlight}
                    onHover={() => setHighlightKey(`channel:${hit.id}`)}
                    onSelect={() => activate(flatIndex)}
                  />
                );
              })}
            </div>
          )}

          {userHits.length > 0 && (
            <div role="group" aria-label="People">
              <SectionHeader>People</SectionHeader>
              {userHits.map((hit) => {
                const flatIndex = items.findIndex(
                  (it) => it.kind === 'user' && it.hit.id === hit.id,
                );
                return (
                  <UserRow
                    key={hit.id}
                    hit={hit}
                    avatarURL={userAvatarMap.get(hit.id)?.avatarURL}
                    highlighted={flatIndex === safeHighlight}
                    onHover={() => setHighlightKey(`user:${hit.id}`)}
                    onSelect={() => activate(flatIndex)}
                  />
                );
              })}
            </div>
          )}

          {searching && channelHits.length === 0 && userHits.length === 0 && (
            <div
              data-testid="searchbar-loading"
              className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Searching…
            </div>
          )}

          <div role="group" aria-label="Messages">
            {(channelHits.length > 0 || userHits.length > 0) && (
              <SectionHeader>Messages</SectionHeader>
            )}
            {suggestions.map((s) => {
              const flatIndex = items.findIndex(
                (it) => it.kind === 'message' && it.suggestion === s,
              );
              const isHighlighted = flatIndex === safeHighlight;
              const Icon = s.kind === 'in-scope' ? FileSearch : Search;
              const scopeNoun =
                s.kind === 'in-scope'
                  ? s.scopeKind === 'channel'
                    ? 'channel'
                    : s.scopeKind === 'group'
                      ? 'group'
                      : 'DM'
                  : '';
              const text =
                s.kind === 'in-scope'
                  ? `Search messages in this ${scopeNoun} for: `
                  : `Search messages for: `;
              return (
                <button
                  key={s.kind === 'in-scope' ? `in-${s.scopeKind}` : 'all'}
                  type="button"
                  onMouseEnter={() =>
                    setHighlightKey(`message:${s.kind === 'in-scope' ? `in-${s.scopeKind}` : 'all'}`)
                  }
                  onClick={() => activate(flatIndex)}
                  data-testid={
                    s.kind === 'in-scope'
                      ? 'searchbar-show-in-scope'
                      : 'searchbar-show-results'
                  }
                  data-scope-kind={s.kind === 'in-scope' ? s.scopeKind : undefined}
                  aria-selected={isHighlighted}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm max-md:py-3 max-md:text-base ${
                    isHighlighted ? 'bg-muted' : ''
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">
                      {text}
                      <span className="font-semibold">{s.label}</span>
                      {s.kind === 'in-scope' && (
                        <span className="text-muted-foreground">
                          {' '}
                          in <span className="font-medium">{s.parentLabel}</span>
                        </span>
                      )}
                    </span>
                  </span>
                  {isHighlighted && (
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px]">Enter</kbd>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

// Note: no Joined/Join affordance — the backend scopes channel search to
// the caller's memberships (AllowedParentIDs), so every hit is a channel
// the user is already in; a "Join" chip could never truthfully render.
function ChannelRow({
  hit,
  highlighted,
  onHover,
  onSelect,
}: {
  hit: SearchHit;
  highlighted: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const name = String(hit._source.name || hit.id);
  const isPrivate = hit._source.type === 'private';
  return (
    <button
      type="button"
      data-testid={`searchbar-channel-${hit.id}`}
      onMouseEnter={onHover}
      onClick={onSelect}
      aria-selected={highlighted}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm max-md:py-3 max-md:text-base ${
        highlighted ? 'bg-muted' : ''
      }`}
    >
      <ChannelIcon
        type={isPrivate ? 'private' : 'public'}
        className="h-4 w-4 shrink-0 text-muted-foreground"
        ariaLabel=""
      />
      <span className="flex-1 truncate font-medium">~{name}</span>
    </button>
  );
}

function UserRow({
  hit,
  avatarURL,
  highlighted,
  onHover,
  onSelect,
}: {
  hit: SearchHit;
  avatarURL?: string;
  highlighted: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const name = String(hit._source.displayName || hit.id);
  const email = String(hit._source.email ?? '');
  return (
    <button
      type="button"
      data-testid={`searchbar-user-${hit.id}`}
      onMouseEnter={onHover}
      onClick={onSelect}
      aria-selected={highlighted}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm max-md:py-3 max-md:text-base ${
        highlighted ? 'bg-muted' : ''
      }`}
    >
      <Avatar className="h-6 w-6 shrink-0">
        {avatarURL && <AvatarImage src={avatarURL} alt="" />}
        <AvatarFallback className="text-[10px]">{getInitials(name)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{name}</span>
        {email && <span className="ml-2 text-muted-foreground">{email}</span>}
      </span>
    </button>
  );
}
