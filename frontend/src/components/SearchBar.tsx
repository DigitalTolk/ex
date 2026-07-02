import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, FileSearch, X, Loader2 } from 'lucide-react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useChannelBySlug, useUserChannels } from '@/hooks/useChannels';
import { useUserConversations, useCreateConversation } from '@/hooks/useConversations';
import { useSearchUsers, useSearchChannels, type SearchHit } from '@/hooks/useSearch';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ChannelIcon } from '@/components/ChannelIcon';
import { getInitials } from '@/lib/format';

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
export function SearchBar() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
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
  const userHits = useMemo(() => usersQuery.data?.hits ?? [], [usersQuery.data]);
  const channelHits = useMemo(() => channelsQuery.data?.hits ?? [], [channelsQuery.data]);
  const searching = searchEnabled && (usersQuery.isLoading || channelsQuery.isLoading);

  const createConv = useCreateConversation();
  const { data: userChannels } = useUserChannels();
  const joinedIDs = useMemo(
    () => new Set((userChannels ?? []).map((c) => c.channelID)),
    [userChannels],
  );

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

  // Global ⌘K / Ctrl+K — focus and open the search from anywhere in
  // the app, even when focus is elsewhere. Cleaned up on unmount.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Clamp the highlighted index in case the item list shrank.
  const safeHighlight = highlight >= items.length ? 0 : highlight;

  function reset() {
    setOpen(false);
    inputRef.current?.blur();
    setQ('');
    setHighlight(0);
  }

  function submitSuggestion(sel: Suggestion) {
    const label = sel.label.trim();
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
      reset();
      createConv.mutate(
        { type: 'dm', participantIDs: [item.hit.id] },
        { onSuccess: (conv) => navigate(`/conversation/${conv.id}`) },
      );
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
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (items.length > 0) activate();
              } else if (e.key === 'Escape') {
                setOpen(false);
                inputRef.current?.blur();
              } else if (e.key === 'ArrowDown') {
                if (items.length === 0) return;
                e.preventDefault();
                setHighlight((p) => (p + 1) % items.length);
              } else if (e.key === 'ArrowUp') {
                if (items.length === 0) return;
                e.preventDefault();
                setHighlight((p) => (p - 1 + items.length) % items.length);
              }
            }}
            placeholder="Search for anything"
            aria-label="Search"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none max-md:text-base"
            data-testid="searchbar-input"
          />
          <kbd className="hidden items-center gap-0.5 rounded border border-border-strong px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground md:inline-flex">
            ⌘K
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
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg"
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
                    joined={joinedIDs.has(hit.id)}
                    highlighted={flatIndex === safeHighlight}
                    onHover={() => setHighlight(flatIndex)}
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
                    highlighted={flatIndex === safeHighlight}
                    onHover={() => setHighlight(flatIndex)}
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
                  onMouseEnter={() => setHighlight(flatIndex)}
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

function ChannelRow({
  hit,
  joined,
  highlighted,
  onHover,
  onSelect,
}: {
  hit: SearchHit;
  joined: boolean;
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
      <span
        data-testid={`searchbar-channel-${hit.id}-badge`}
        className={
          joined
            ? 'rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
            : 'rounded-full border border-border-strong px-2 py-0.5 text-[11px] font-medium text-foreground'
        }
      >
        {joined ? 'Joined' : 'Join'}
      </span>
    </button>
  );
}

function UserRow({
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
        <AvatarFallback className="text-[10px]">{getInitials(name)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{name}</span>
        {email && <span className="ml-2 text-muted-foreground">{email}</span>}
      </span>
    </button>
  );
}
