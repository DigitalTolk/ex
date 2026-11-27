import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Clock3, Search, FileSearch, X, Loader2, Users, UserRound } from 'lucide-react';
import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useChannelBySlug, useUserChannels } from '@/hooks/useChannels';
import { useUserConversations, useOpenDM } from '@/hooks/useConversations';
import { useSearchModifiers } from '@/hooks/useSearchModifiers';
import { allUsersQuery } from '@/lib/people-query';
import { parseSearchModifiers, unmatchedNote, type SearchModifier } from '@/lib/search-modifiers';
import {
  activeModifier,
  completeModifier,
  personHandle,
  placeHandle,
  suggestDays,
  suggestPeople,
  suggestPlaces,
  type Place,
} from '@/lib/search-suggest';
import { useSearchUsers, useSearchChannels, useSearchMessages, type SearchHit } from '@/hooks/useSearch';
import { searchFailure } from '@/lib/search-failure';
import { groupsMatching } from '@/lib/conversation-match';
import { MessageHitCard } from '@/components/search/MessageHitCard';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useIsOnline } from '@/stores/presence';
import { Badge } from '@/components/ui/badge';
import { ChannelIcon } from '@/components/ChannelIcon';
import { UserPickerRow } from '@/components/UserPickerRow';
import { isApplePlatform, searchShortcutLabel } from '@/lib/platform';
import type { UserConversation, UserStatus } from '@/types';
import {
  addRecentOpened,
  addRecentSearch,
  clearRecentOpened,
  clearRecentSearches,
  removeRecentOpened,
  removeRecentSearch,
  useRecentSearchesStore,
  type RecentOpened,
} from '@/stores/recent-searches';

// ⌘K on Apple platforms, Ctrl K elsewhere. The keydown handler matches the
// SAME platform chord as this hint — on Apple only Cmd+K (a bare Ctrl+K is
// kill-to-end-of-line in text fields and a CodeMirror binding), on other
// platforms only Ctrl+K. The handler re-reads the UA per event (trivial
// regex) so tests can drive both platform branches.
const SEARCH_SHORTCUT_HINT = searchShortcutLabel(navigator.userAgent);

// ⌘1 to ⌘9 (Ctrl+1 to Ctrl+9 elsewhere) pick the dropdown's first nine rows,
// for people who would rather not reach for the arrows.
const NUMBER_SHORTCUTS = 9;

// isPlatformModifierKey: the key pressed is ⌘ on Apple platforms, Ctrl
// elsewhere — the one the number shortcuts are held with.
function isPlatformModifierKey(e: { key: string }): boolean {
  return e.key === (isApplePlatform(navigator.userAgent) ? 'Meta' : 'Control');
}

// numberShortcut is the row number (1 to 9) a key press picks, or 0: the
// platform modifier alone with a digit, as with ⌘K.
function numberShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): number {
  const apple = isApplePlatform(navigator.userAgent);
  const chord = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!chord || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key)) return 0;
  return Number(e.key);
}

function numberShortcutLabel(n: number): string {
  return isApplePlatform(navigator.userAgent) ? `⌘${n}` : `Ctrl ${n}`;
}

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
  | { kind: 'group'; conversation: UserConversation }
  | { kind: 'message'; suggestion: Suggestion }
  // With the field empty the bar lists what was opened and searched lately.
  | { kind: 'recent'; entry: RecentOpened }
  | { kind: 'recent-query'; query: string }
  // While from: or in: is being typed: the people or chats it can name.
  | { kind: 'modifier'; option: ModifierOption }
  // With the field empty: the modifiers there are, to start one.
  | { kind: 'modifier-hint'; key: SearchModifier };

interface ModifierOption {
  key: SearchModifier;
  id: string;
  label: string;
  detail?: string;
  // What picking it writes after the colon.
  value: string;
  // A chat's kind, for its icon (in: only).
  place?: Place['kind'];
  channelType?: string;
}

// The empty field offers from: and in:; the date modifiers (on:, before:,
// after:) work and suggest days when typed, without crowding this list.
const MODIFIER_HINTS: { key: SearchModifier; example: string; description: string }[] = [
  { key: 'from', example: 'from:', description: 'Messages from a person' },
  { key: 'in', example: 'in:', description: 'Messages in a channel or DM' },
];
const MODIFIER_TITLE: Record<SearchModifier, string> = { from: 'From', in: 'In', on: 'On', before: 'Before', after: 'After' };

const MIN_SEARCH_CHARS = 2;

// SearchBar — Slack-style unified top search. ⌘K / Ctrl+K focuses it
// from anywhere. Typing ≥2 chars debounce-fetches matching channels
// and people and renders them as sections, followed by a "Search
// messages for <q>" action (plus an in-scope action on a channel/DM
// route). Keyboard nav (ArrowUp/Down + Enter), Escape closes.
//  • Channel row  → navigate to /channel/:slug
//  • Person row   → open/create a DM, navigate to /conversation/:id
//  • Group row    → the group message with those people (several names
//                   typed find the group they're all in)
//  • Message row  → navigate to /search?q=… (unchanged message flow)
// itemKey gives every dropdown row a stable identity so the highlight can
// survive the item list changing under it (async hits arriving/reordering).
function itemKey(it: Item): string {
  if (it.kind === 'message') {
    return `message:${it.suggestion.kind === 'in-scope' ? `in-${it.suggestion.scopeKind}` : 'all'}`;
  }
  if (it.kind === 'group') return `group:${it.conversation.conversationID}`;
  if (it.kind === 'recent') return `recent:${it.entry.kind}:${it.entry.id}`;
  if (it.kind === 'recent-query') return `recent-query:${it.query}`;
  if (it.kind === 'modifier') return `modifier:${it.option.key}:${it.option.id}`;
  if (it.kind === 'modifier-hint') return `modifier-hint:${it.key}`;
  return `${it.kind}:${it.hit.id}`;
}

interface SearchBarProps {
  // 'bar' (default): the top-bar field with a dropdown. 'sheet': the mobile
  // search sheet — results and recent searches render inline below the field.
  variant?: 'bar' | 'sheet';
  // Called after a pick navigates away (the sheet closes then).
  onDone?: () => void;
  // Rendered before the field (the sheet's back button).
  leading?: ReactNode;
}

export function SearchBar({ variant = 'bar', onDone, leading }: SearchBarProps) {
  const sheet = variant === 'sheet';
  // The signed-in user's recent searches and what they opened from search;
  // only the sheet shows (or records) them.
  const recent = useRecentSearchesStore((st) => st.queries);
  const opened = useRecentSearchesStore((st) => st.opened);
  const [q, setQ] = useState('');
  // Sheet only: the message search the user ran, shown in place. Editing the
  // text goes back to the live suggestions until they run it again.
  const [submitted, setSubmitted] = useState<{ q: string; scope?: SearchScope } | null>(null);
  const [open, setOpen] = useState(false);
  // The platform modifier (⌘, or Ctrl) is held in the field: the numbers
  // that pick the first nine rows show in full.
  const [numbersShown, setNumbersShown] = useState(false);
  // Highlight tracks item IDENTITY, not index — null means "no explicit
  // selection", which resolves to the message-search action. Index-based
  // highlighting made Enter's destination fetch-timing-dependent: channel
  // hits landing just before the keypress would prepend at index 0 and
  // steal an Enter meant for "Search messages for: <q>".
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  // The field is an ARIA combobox over this listbox; focus stays in the
  // field and the highlighted option is its active descendant.
  const listboxId = useId();
  // A row that isn't in the list has no id, and must never take the bar
  // down: a section rendered out of step with the list once crashed the page.
  /* v8 ignore next */
  /* istanbul ignore next -- every rendered row is in the list today (the sections follow it); the missing-row arm is the crash guard */
  const optionId = (it: Item | undefined) => (it ? `${listboxId}-${itemKey(it)}` : undefined);

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
  // The channel and people lookups search the words alone: "datadog
  // from:carol" looks up "datadog", and the modifiers go with the message
  // search as typed.
  // The modifier still being typed ("from:", "from:ca") is left out too.
  const active = useMemo(() => activeModifier(q), [q]);
  const words = useMemo(
    () => parseSearchModifiers(active ? q.slice(0, active.start) : trimmed).text,
    [active, q, trimmed],
  );
  // Entity (channel/people) lookups are debounced so a fast typist
  // doesn't fire a request per keystroke; the message action always
  // reflects the live query so Enter feels instant.
  const debouncedQ = useDebouncedValue(words, 150);
  const searchEnabled = debouncedQ.length >= MIN_SEARCH_CHARS;
  const usersQuery = useSearchUsers(debouncedQ, searchEnabled, 5);
  const channelsQuery = useSearchChannels(debouncedQ, searchEnabled, 5);
  // Hits render only while BOTH the live and the debounced query clear the
  // minimum. keepPreviousData deliberately holds the previous query's hits
  // during a refetch (no flicker mid-typing), but once the input drops
  // below the minimum — or is cleared — those stale rows must neither
  // render nor stay Enter-activatable (backspacing "gen" → "g" used to
  // leave ~general in the hidden item list, and Enter navigated there).
  const hitsEnabled = searchEnabled && words.length >= MIN_SEARCH_CHARS;
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
  // Presence powers the online/offline dot on each people row (each row
  // subscribes to its own user, see UserRow); the batch record above carries
  // the custom status emoji. Both are the "status icon" a person row shows
  // here and on the full /search page.
  // Your group messages with the people named, from the list you already
  // have: "alice bob" finds the group with both.
  const groupHits = useMemo(
    () => (words.length >= MIN_SEARCH_CHARS ? groupsMatching(userConversations ?? [], words) : []),
    [words, userConversations],
  );
  const searching = searchEnabled && (usersQuery.isLoading || channelsQuery.isLoading);
  const failedQuery = hitsEnabled ? [usersQuery, channelsQuery].find((query) => query.isError) : undefined;

  // Channel search now surfaces PUBLIC channels the user hasn't joined (opening
  // one auto-joins them), so a hit isn't necessarily a channel they're in. The
  // joined set lets the row show a "Join" hint on the ones that aren't.
  const { data: userChannels } = useUserChannels();
  const joinedIDs = useMemo(
    () => new Set((userChannels ?? []).map((c) => c.channelID)),
    [userChannels],
  );

  // Suggestions for the modifier being typed. The people list is the app's
  // roster, loaded the first time from: is typed (never for a plain search);
  // the chats are the sidebar's own lists.
  const { data: roster } = useQuery({ ...allUsersQuery(), enabled: active?.key === 'from' });
  const places = useMemo<Place[]>(
    () => [
      ...(userChannels ?? []).map((c): Place => ({ id: c.channelID, name: c.channelName, kind: 'channel' })),
      ...(userConversations ?? []).map((c): Place => ({ id: c.conversationID, name: c.displayName, kind: 'conversation' })),
    ],
    [userChannels, userConversations],
  );
  const channelTypes = useMemo(
    () => new Map((userChannels ?? []).map((c) => [c.channelID, c.channelType])),
    [userChannels],
  );
  const modifierOptions = useMemo<ModifierOption[]>(() => {
    if (!active) return [];
    if (active.key === 'on' || active.key === 'before' || active.key === 'after') {
      return suggestDays(active.partial).map((d) => ({ key: active.key, id: d.value, label: d.label, detail: d.detail, value: d.value }));
    }
    if (active.key === 'from') {
      const people = roster ?? [];
      return suggestPeople(active.partial, people).map((p) => ({
        key: 'from',
        id: p.id,
        label: p.displayName,
        detail: p.email,
        value: personHandle(p, people),
      }));
    }
    return suggestPlaces(active.partial, places).map((p) => ({
      key: 'in',
      id: p.id,
      label: p.kind === 'channel' ? `~${p.name}` : p.name,
      value: placeHandle(p, places),
      place: p.kind,
      channelType: channelTypes.get(p.id),
    }));
  }, [active, roster, places, channelTypes]);
  // Once the name is typed out in full ("from:Carol"), the list steps aside:
  // Enter (or a phone's Search key) runs the search instead of re-picking it.
  const modifierDone =
    !!active && modifierOptions.some((o) => o.value.replace(/^"|"$/g, '').toLowerCase() === active.partial.toLowerCase());
  const modifierMode = modifierOptions.length > 0 && !modifierDone;

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
  // then people, then the message actions. With the field empty, the bar's
  // list is what was opened lately, then the recent searches (the sheet shows
  // those as plain buttons of its own).
  const items = useMemo<Item[]>(() => {
    const arr: Item[] = [];
    if (!trimmed) {
      if (sheet) return arr;
      for (const hint of MODIFIER_HINTS) arr.push({ kind: 'modifier-hint', key: hint.key });
      for (const entry of opened) arr.push({ kind: 'recent', entry });
      for (const query of recent) arr.push({ kind: 'recent-query', query });
      return arr;
    }
    // Typing from: or in:, the list is what it can name, nothing else.
    if (modifierMode) return modifierOptions.map((option): Item => ({ kind: 'modifier', option }));
    for (const h of channelHits) arr.push({ kind: 'channel', hit: h });
    for (const h of userHits) arr.push({ kind: 'user', hit: h });
    for (const c of groupHits) arr.push({ kind: 'group', conversation: c });
    for (const s of suggestions) arr.push({ kind: 'message', suggestion: s });
    return arr;
  }, [trimmed, sheet, opened, recent, modifierMode, modifierOptions, channelHits, userHits, groupHits, suggestions]);

  useEffect(() => {
    if (!open || sheet) return;
    function onDoc(e: MouseEvent) {
      /* istanbul ignore next -- containerRef is always attached while the dropdown is open; defensive null guard */
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, sheet]);

  // Global ⌘K (Apple) / Ctrl+K (elsewhere) — focus and open the search from
  // anywhere in the app, even while typing in the composer. ⌘F / Ctrl+F does
  // the same: "find" means the app's search here, not the page's. Strictly the
  // platform chord: the other modifier, Shift/Alt combos (Cmd+Shift+K etc.)
  // and key-repeat are ignored so native text-editing bindings and other
  // shortcuts are never hijacked. Cleaned up on unmount.
  useEffect(() => {
    if (sheet) return;
    function onKey(e: KeyboardEvent) {
      const apple = isApplePlatform(navigator.userAgent);
      const chord = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!chord || e.shiftKey || e.altKey || e.repeat) return;
      const key = e.key.toLowerCase();
      if (key !== 'k' && key !== 'f') return;
      e.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet]);

  // Resolve the highlight identity to today's index. A vanished selection
  // (the list shrank or changed) and "no explicit selection" both fall back
  // to the message-search action — the only row whose meaning is stable
  // while fetches are in flight, and the one that always reflects the LIVE
  // query text.
  // While a modifier is typed, the first name it could take. With the field
  // empty, Enter keeps opening the first recent item, and with no history it
  // does nothing (-1): the search options are there to click or arrow to.
  const defaultIdx = modifierMode
    ? 0
    : items.findIndex((it) => it.kind === 'message' || it.kind === 'recent' || it.kind === 'recent-query');
  const keyedIdx = highlightKey === null ? -1 : items.findIndex((it) => itemKey(it) === highlightKey);
  const safeHighlight = keyedIdx >= 0 ? keyedIdx : defaultIdx;

  function reset() {
    setOpen(false);
    inputRef.current?.blur();
    setQ('');
    setHighlightKey(null);
    onDone?.();
  }

  function submitSuggestion(sel: Suggestion) {
    const label = sel.label.trim();
    /* istanbul ignore next -- suggestions are built only from non-empty trimmed input (and Enter is gated on the visible dropdown), so a message item always carries a label; defensive */
    if (!label) return;
    addRecentSearch(label);
    if (sheet) {
      // Results show right here; drop the keyboard so they have the room.
      setSubmitted({ q: label, scope: sel.kind === 'in-scope' ? { parentId: sel.parentId, scopeKind: sel.scopeKind } : undefined });
      inputRef.current?.blur();
      return;
    }
    reset();
    navigate(searchPageHref(label, sel.kind === 'in-scope' ? { parentId: sel.parentId, scopeKind: sel.scopeKind } : undefined));
  }

  // A recent search runs again: in place in the sheet, on the search page
  // from the bar.
  function runRecent(query: string) {
    addRecentSearch(query);
    if (!sheet) {
      reset();
      navigate(searchPageHref(query));
      return;
    }
    setQ(query);
    setSubmitted({ q: query });
  }

  // Opening a channel, person or group from search puts it on top of the
  // "Recently opened" list, so it's one step away next time.
  function remember(entry: RecentOpened) {
    addRecentOpened(entry);
  }

  function openRecent(entry: RecentOpened) {
    if (entry.kind === 'user') {
      openDM(entry.id, {
        onSuccess: () => {
          remember(entry);
          reset();
        },
      });
      return;
    }
    remember(entry);
    reset();
    navigate(entry.kind === 'channel' ? `/channel/${entry.slug}` : `/conversation/${entry.id}`);
  }

  function activate(idx = safeHighlight) {
    /* istanbul ignore next -- safeHighlight is clamped in-range; the ?? fallback and the !item guard are defensive (the dropdown only renders when items is non-empty) */
    const item = items[idx] ?? items[0];
    /* istanbul ignore next -- defensive: activate is only reachable while the dropdown is open, which requires at least one item */
    if (!item) return;
    if (item.kind === 'channel') {
      const slug = String(item.hit._source.slug || item.hit.id);
      remember({
        kind: 'channel',
        id: item.hit.id,
        slug,
        name: String(item.hit._source.name || item.hit.id),
        private: item.hit._source.type === 'private',
      });
      reset();
      navigate(`/channel/${slug}`);
    } else if (item.kind === 'user') {
      // reset() only on success: a failed DM-create keeps the typed query
      // and the open dropdown (plus useOpenDM's error toast) so the user
      // can retry instead of facing a silently cleared search box.
      const entry: RecentOpened = { kind: 'user', id: item.hit.id, name: String(item.hit._source.displayName || item.hit.id) };
      openDM(item.hit.id, {
        onSuccess: () => {
          remember(entry);
          reset();
        },
      });
    } else if (item.kind === 'group') {
      remember({ kind: 'group', id: item.conversation.conversationID, name: item.conversation.displayName });
      reset();
      navigate(`/conversation/${item.conversation.conversationID}`);
    } else if (item.kind === 'recent') {
      openRecent(item.entry);
    } else if (item.kind === 'recent-query') {
      runRecent(item.query);
    } else if (item.kind === 'modifier') {
      /* istanbul ignore next -- modifier rows exist only while one is being typed; defensive */
      if (!active) return;
      edit(completeModifier(q, active, item.option.value));
    } else if (item.kind === 'modifier-hint') {
      edit(`${item.key}:`);
    } else {
      submitSuggestion(item.suggestion);
    }
  }

  function clear() {
    setQ('');
    inputRef.current?.focus();
  }

  // edit writes the field for the user (a picked suggestion) and keeps them
  // in it, typing on.
  function edit(next: string) {
    setQ(next);
    setOpen(true);
    setHighlightKey(null);
    inputRef.current?.focus();
  }

  const showMessageResults = sheet && submitted !== null && submitted.q === trimmed;
  // While the sheet shows message results, its list keeps only the channel and
  // people hits — and isn't rendered at all when there are none.
  const showDropdown =
    (open || sheet) &&
    suggestions.length > 0 &&
    !(showMessageResults && channelHits.length === 0 && userHits.length === 0 && groupHits.length === 0);
  // The sheet's empty field lists the search options, then any history.
  const showRecent = sheet && !trimmed;
  // The bar's own recent list, while the empty field has focus.
  const showRecentDropdown = !sheet && open && !trimmed && items.length > 0;
  const listOpen = (showDropdown || showRecentDropdown) && items.length > 0;
  // ⌘1 to ⌘9 (Ctrl elsewhere) beside the first nine rows, faded until the
  // modifier is held (index.css): one rule per row's id, so the rows
  // themselves stay as they are. Not on a phone's sheet: no keyboard there.
  const numberRules =
    listOpen && !sheet
      ? items
          .slice(0, NUMBER_SHORTCUTS)
          .map((it, i) => `#${CSS.escape(optionId(it)!)}::after{content:'${numberShortcutLabel(i + 1)}'}`)
          .join('')
      : '';

  return (
    <div ref={containerRef} className="relative w-full" data-testid="searchbar" data-shortcuts-held={numbersShown || undefined}>
      {/* Rectangular global search per the design — rounded-md corners
          (6px), subtle 1px border, search glyph on the left. On focus
          the field lifts (raised elevation) and widens a touch on
          desktop for a Slack-like focus-expand; the growth is symmetric
          so the centred grid column stays centred, and it's gated to
          md+ so mobile layout is untouched. */}
      <div className={sheet ? 'flex items-center gap-1' : 'rounded-md transition-all duration-150 focus-within:shadow-lg md:focus-within:-mx-2'}>
        {leading}
        <div className="flex min-w-0 flex-1 h-8 items-center gap-2 rounded-md border border-border bg-background dark:bg-muted px-3 text-foreground transition-colors focus-within:border-ring hover:border-border-strong mobile:h-11">
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
            onFocus={() => {
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (isPlatformModifierKey(e)) setNumbersShown(true);
              // ⌘1 to ⌘9 (Ctrl elsewhere) picks that row, counted from the top.
              const number = numberShortcut(e);
              if (number && listOpen) {
                e.preventDefault();
                if (number <= items.length) activate(number - 1);
                return;
              }
              // Enter and the arrows act only on the VISIBLE dropdown — a
              // hidden item list (empty/cleared input) must never be
              // activatable; the old handler navigated to stale hits on
              // Enter with an empty search box.
              if (e.key === 'Enter') {
                e.preventDefault();
                if (listOpen && safeHighlight >= 0) activate();
              } else if (e.key === 'Tab' && modifierMode && listOpen) {
                // Tab takes the highlighted name, as in a terminal.
                e.preventDefault();
                activate();
              } else if (e.key === 'Escape') {
                // Leaving the search is all this Escape does.
                e.preventDefault();
                setOpen(false);
                inputRef.current?.blur();
              } else if (e.key === 'ArrowDown') {
                if (!listOpen) return;
                e.preventDefault();
                setHighlightKey(itemKey(items[safeHighlight < 0 ? 0 : (safeHighlight + 1) % items.length]));
              } else if (e.key === 'ArrowUp') {
                if (!listOpen) return;
                e.preventDefault();
                setHighlightKey(itemKey(items[safeHighlight < 0 ? items.length - 1 : (safeHighlight - 1 + items.length) % items.length]));
              }
            }}
            onKeyUp={(e) => {
              if (isPlatformModifierKey(e)) setNumbersShown(false);
            }}
            onBlur={() => setNumbersShown(false)}
            placeholder="Search for anything"
            aria-label="Search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-controls={listOpen ? listboxId : undefined}
            aria-activedescendant={listOpen && safeHighlight >= 0 ? optionId(items[safeHighlight]) : undefined}
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
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none mobile:text-base"
            data-testid="searchbar-input"
          />
          <kbd className="hidden items-center gap-0.5 rounded border border-border-strong px-1.5 py-0.5 text-xs font-medium text-muted-foreground md:inline-flex">
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
          data-testid="searchbar-dropdown"
          // Match the focus-expanded input width: the input row widens by -mx-2
          // on md+ while focused, and the dropdown only ever shows while focused,
          // so mirror that same negative margin here so their edges line up.
          // It opens out of the top bar, which drags the desktop window; the
          // dropdown itself is for picking and scrolling, not for dragging.
          className={
            sheet
              ? 'mt-2 text-foreground'
              : 'absolute left-0 right-0 top-full z-40 mt-1 max-h-[70dvh] overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-lg md:-mx-2 [-webkit-app-region:no-drag]'
          }
        >
          {/* Status rows sit above the options, outside the listbox: a
              listbox holds only options and their groups. */}
          {failedQuery && (
            <div
              role="alert"
              data-testid="searchbar-failed"
              className="flex items-center gap-2 px-3 py-2 text-sm text-destructive"
            >
              <span className="min-w-0 flex-1">{searchFailure(failedQuery.error)}</span>
              <button
                type="button"
                className="rounded px-1.5 font-medium underline-offset-2 hover:underline"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (usersQuery.isError) void usersQuery.refetch();
                  if (channelsQuery.isError) void channelsQuery.refetch();
                }}
              >
                Try again
              </button>
            </div>
          )}

          {searching && channelHits.length === 0 && userHits.length === 0 && groupHits.length === 0 && (
            <div
              data-testid="searchbar-loading"
              className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Searching…
            </div>
          )}

          <div role="listbox" id={listboxId} aria-label="Suggestions">
          {numberRules && <style data-testid="searchbar-number-shortcuts">{numberRules}</style>}
          {modifierMode && (
            <div role="group" aria-label={MODIFIER_TITLE[active!.key]}>
              <SectionHeader>{MODIFIER_TITLE[active!.key]}</SectionHeader>
              {modifierOptions.map((option) => {
                const flatIndex = items.findIndex((it) => it.kind === 'modifier' && it.option === option);
                return (
                  <ModifierRow
                    key={option.id}
                    id={optionId(items[flatIndex])}
                    option={option}
                    highlighted={flatIndex === safeHighlight}
                    onHover={() => setHighlightKey(`modifier:${option.key}:${option.id}`)}
                    onSelect={() => activate(flatIndex)}
                  />
                );
              })}
            </div>
          )}
          {!modifierMode && channelHits.length > 0 && (
            <div role="group" aria-label="Channels">
              <SectionHeader>Channels</SectionHeader>
              {channelHits.map((hit) => {
                const flatIndex = items.findIndex(
                  (it) => it.kind === 'channel' && it.hit.id === hit.id,
                );
                return (
                  <ChannelRow
                    key={hit.id}
                    id={optionId(items[flatIndex])}
                    hit={hit}
                    joined={joinedIDs.has(hit.id)}
                    highlighted={flatIndex === safeHighlight}
                    onHover={() => setHighlightKey(`channel:${hit.id}`)}
                    onSelect={() => activate(flatIndex)}
                  />
                );
              })}
            </div>
          )}

          {!modifierMode && userHits.length > 0 && (
            <div role="group" aria-label="People">
              <SectionHeader>People</SectionHeader>
              {userHits.map((hit) => {
                const flatIndex = items.findIndex(
                  (it) => it.kind === 'user' && it.hit.id === hit.id,
                );
                return (
                  <UserRow
                    key={hit.id}
                    id={optionId(items[flatIndex])}
                    hit={hit}
                    avatarURL={userAvatarMap.get(hit.id)?.avatarURL}
                    userStatus={userAvatarMap.get(hit.id)?.userStatus}
                    highlighted={flatIndex === safeHighlight}
                    onHover={() => setHighlightKey(`user:${hit.id}`)}
                    onSelect={() => activate(flatIndex)}
                  />
                );
              })}
            </div>
          )}

          {!modifierMode && groupHits.length > 0 && (
            <div role="group" aria-label="Group messages">
              <SectionHeader>Group messages</SectionHeader>
              {groupHits.map((conversation) => {
                const flatIndex = items.findIndex(
                  (it) => it.kind === 'group' && it.conversation.conversationID === conversation.conversationID,
                );
                return (
                  <GroupRow
                    key={conversation.conversationID}
                    id={optionId(items[flatIndex])}
                    conversation={conversation}
                    highlighted={flatIndex === safeHighlight}
                    onHover={() => setHighlightKey(`group:${conversation.conversationID}`)}
                    onSelect={() => activate(flatIndex)}
                  />
                );
              })}
            </div>
          )}

          {/* While the sheet shows message results, they are their own section
              (below) and this group of "search for…" actions steps aside. */}
          {!showMessageResults && !modifierMode && (
            <div role="group" aria-label="Messages">
              {(channelHits.length > 0 || userHits.length > 0 || groupHits.length > 0) && <SectionHeader>Messages</SectionHeader>}
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
                    id={optionId(items[flatIndex])}
                    type="button"
                    role="option"
                    tabIndex={-1}
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
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm mobile:py-3 mobile:text-base ${
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
                      // ml-auto: at the right edge, beside the row's number.
                      <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 text-xs mobile:hidden">Enter</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          </div>
        </div>
      )}
      {showMessageResults && submitted && <SheetMessageResults submitted={submitted} onDone={onDone} />}
      {(showRecent || showRecentDropdown) && (
        <div
          data-testid="recent-searches"
          className={
            sheet
              ? 'mt-2'
              : 'absolute left-0 right-0 top-full z-40 mt-1 max-h-[70dvh] overflow-y-auto rounded-md border bg-popover pb-1 text-popover-foreground shadow-lg md:-mx-2 [-webkit-app-region:no-drag]'
          }
        >
          <div {...(sheet ? {} : { role: 'listbox', id: listboxId, 'aria-label': 'Recent' })}>
            {numberRules && <style data-testid="searchbar-number-shortcuts">{numberRules}</style>}
            <div role="group" aria-label="Search options">
              <SectionHeader>Search options</SectionHeader>
              {MODIFIER_HINTS.map((hint) => {
                const idx = items.findIndex((it) => it.kind === 'modifier-hint' && it.key === hint.key);
                // The sheet's rows aren't in the keyboard list (-1): never lit.
                const highlighted = idx >= 0 && idx === safeHighlight;
                return (
                  <button
                    key={hint.key}
                    // The bar's rows are options of its listbox; the sheet's
                    // are plain buttons, like its recent rows.
                    {...(sheet
                      ? {}
                      : { id: optionId(items[idx]), role: 'option', tabIndex: -1, 'aria-selected': highlighted })}
                    type="button"
                    // Keeps the field focused, so typing goes on.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlightKey(`modifier-hint:${hint.key}`)}
                    onClick={() => edit(`${hint.key}:`)}
                    data-testid={`search-option-${hint.key}`}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm mobile:min-h-11 mobile:text-base ${highlighted ? 'bg-muted' : ''}`}
                  >
                    <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">{hint.example}</code>
                    <span className="text-muted-foreground">{hint.description}</span>
                  </button>
                );
              })}
            </div>
            {opened.length > 0 && (
              <RecentSection title="Recently opened" onClear={clearRecentOpened} clearTestID="recent-opened-clear" sheet={sheet}>
                {opened.map((entry) => {
                  const label = entry.kind === 'channel' ? `~${entry.name}` : entry.name;
                  const idx = items.findIndex((it) => it.kind === 'recent' && it.entry === entry);
                  return (
                    <RecentRow
                      key={`${entry.kind}:${entry.id}`}
                      sheet={sheet}
                      testID="recent-opened"
                      optionId={idx >= 0 ? optionId(items[idx]) : undefined}
                      highlighted={idx === safeHighlight}
                      onHover={() => setHighlightKey(`recent:${entry.kind}:${entry.id}`)}
                      onSelect={() => openRecent(entry)}
                      onRemove={() => removeRecentOpened(entry)}
                      removeLabel={`Remove ${label} from recently opened`}
                      icon={
                        entry.kind === 'channel' ? (
                          <ChannelIcon
                            type={entry.private ? 'private' : 'public'}
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            ariaLabel=""
                          />
                        ) : entry.kind === 'group' ? (
                          <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        ) : (
                          <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        )
                      }
                      label={label}
                    />
                  );
                })}
              </RecentSection>
            )}
            {recent.length > 0 && (
              <RecentSection title="Recent searches" onClear={clearRecentSearches} clearTestID="recent-searches-clear" sheet={sheet}>
                {recent.map((query) => {
                  const idx = items.findIndex((it) => it.kind === 'recent-query' && it.query === query);
                  return (
                    <RecentRow
                      key={query}
                      sheet={sheet}
                      testID="recent-search"
                      optionId={idx >= 0 ? optionId(items[idx]) : undefined}
                      highlighted={idx === safeHighlight}
                      onHover={() => setHighlightKey(`recent-query:${query}`)}
                      onSelect={() => runRecent(query)}
                      onRemove={() => removeRecentSearch(query)}
                      removeLabel={`Remove ${query} from recent searches`}
                      icon={<Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                      label={query}
                    />
                  );
                })}
              </RecentSection>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface SearchScope {
  parentId: string;
  scopeKind: ScopeKind;
}

// searchPageHref links the full search page for a query, scoped to a channel or
// conversation when one is given — landing directly on the tab that matches
// the scope (channels → "messages"; DMs/groups → "dms", the tab filtered to
// parentType=conversation), skipping All's noise from Channels/People.
function searchPageHref(q: string, scope?: SearchScope): string {
  const params = new URLSearchParams({ q });
  if (scope) {
    params.set('in', scope.parentId);
    params.set('type', scope.scopeKind === 'channel' ? 'messages' : 'dms');
  }
  return `/search?${params.toString()}`;
}

// SheetMessageResults is the sheet's message search, run in place: the
// search as typed, its from:/in: modifiers read like the search page reads
// them. Mounted only once a search runs, so the bar never loads the people
// and chats those modifiers resolve against.
function SheetMessageResults({ submitted, onDone }: { submitted: { q: string; scope?: SearchScope }; onDone?: () => void }) {
  const search = useSearchModifiers(submitted.q);
  const messagesQuery = useSearchMessages(
    search.text,
    !search.pending && !search.unmatched,
    20,
    { in: submitted.scope?.parentId ?? search.inID, from: search.fromID, after: search.after, before: search.before },
  );
  const messageHits = messagesQuery.data?.hits ?? [];
  return (
    <section aria-label="Messages" className="mt-2" data-testid="sheet-message-section">
      <SectionHeader>Messages</SectionHeader>
      {/* A tap on a result that opens it (a link) closes the sheet behind
          it; a tap anywhere else — a placeholder, the empty state, a
          result that can't open — leaves it up. */}
      <div
        className="space-y-2 pt-1"
        onClick={(e) => {
          if ((e.target as Element).closest('a[href]')) onDone?.();
        }}
        data-testid="sheet-message-results"
      >
        {search.unmatched ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-testid="sheet-unmatched-modifier">
            {unmatchedNote(search.unmatched)}
          </p>
        ) : messagesQuery.isLoading || search.pending ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)
        ) : messageHits.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-testid="sheet-message-empty">
            No messages match “{submitted.q}”.
          </p>
        ) : (
          messageHits.map((h) => <MessageHitCard key={h.id} hit={h} />)
        )}
      </div>
      {messageHits.length > 0 && (
        <Link
          to={searchPageHref(submitted.q, submitted.scope)}
          onClick={() => onDone?.()}
          className="flex min-h-11 items-center justify-center text-sm font-medium text-muted-foreground hover:text-foreground"
          data-testid="sheet-all-results"
        >
          All results
        </Link>
      )}
    </section>
  );
}

// ModifierRow is one person (from:) or chat (in:) the modifier being typed
// can name; picking it completes the word in the field.
function ModifierRow({
  id,
  option,
  highlighted,
  onHover,
  onSelect,
}: {
  id?: string;
  option: ModifierOption;
  highlighted: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const icon =
    option.key === 'on' || option.key === 'before' || option.key === 'after' ? (
      <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    ) : option.key === 'from' ? (
      <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    ) : option.place === 'channel' ? (
      <ChannelIcon type={option.channelType === 'private' ? 'private' : 'public'} className="h-4 w-4 shrink-0 text-muted-foreground" ariaLabel="" />
    ) : (
      <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    );
  return (
    <button
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={highlighted}
      // Keeps the field focused, so typing goes on after the pick.
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onSelect}
      data-testid="search-modifier-option"
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm mobile:py-3 mobile:text-base ${highlighted ? 'bg-muted' : ''}`}
    >
      {icon}
      <span className="truncate font-medium">{option.label}</span>
      {option.detail && <span className="truncate text-muted-foreground">{option.detail}</span>}
      {highlighted && <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 text-xs mobile:hidden">Tab</kbd>}
    </button>
  );
}

// A titled block of the recent list with its own Clear. In the bar it is an
// option group of the listbox; the field keeps focus while it is clicked.
function RecentSection({
  title,
  onClear,
  clearTestID,
  sheet,
  children,
}: {
  title: string;
  onClear: () => void;
  clearTestID: string;
  sheet: boolean;
  children: ReactNode;
}) {
  return (
    <div {...(sheet ? {} : { role: 'group', 'aria-label': title })}>
      <div className="flex items-center justify-between">
        <SectionHeader>{title}</SectionHeader>
        <button
          type="button"
          tabIndex={sheet ? undefined : -1}
          onMouseDown={sheet ? undefined : (e) => e.preventDefault()}
          onClick={onClear}
          className={`px-3 text-xs font-medium text-muted-foreground hover:text-foreground ${sheet ? 'min-h-11' : 'pt-1'}`}
          data-testid={clearTestID}
        >
          Clear
        </button>
      </div>
      {children}
    </div>
  );
}

// One recent entry: a row that opens or runs it, and an × that forgets it. In
// the bar the row is an option the arrow keys reach.
function RecentRow({
  sheet,
  testID,
  optionId,
  highlighted,
  onHover,
  onSelect,
  onRemove,
  removeLabel,
  icon,
  label,
}: {
  sheet: boolean;
  testID: string;
  optionId?: string;
  highlighted: boolean;
  onHover: () => void;
  onSelect: () => void;
  onRemove: () => void;
  removeLabel: string;
  icon: ReactNode;
  label: string;
}) {
  if (sheet) {
    return (
      <div className="flex items-center">
        <button
          type="button"
          onClick={onSelect}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 text-left text-base"
          data-testid={testID}
        >
          {icon}
          <span className="truncate">{label}</span>
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div className={`flex items-center ${highlighted ? 'bg-muted' : ''}`} onMouseEnter={onHover}>
      <button
        id={optionId}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={highlighted}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
        data-testid={testID}
      >
        {icon}
        <span className="flex-1 truncate">{label}</span>
        </button>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRemove}
        aria-label={removeLabel}
        className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

// Channel search surfaces public channels the user hasn't joined too, so a hit
// may or may not be one they're in. A neutral "Join" hint marks the ones that
// aren't (clicking the row navigates and auto-joins them, Slack-style); joined
// channels carry no badge to keep the common case uncluttered. The hint is
// never pink — it's a plain outline Badge per the design system.
function GroupRow({
  id,
  conversation,
  highlighted,
  onHover,
  onSelect,
}: {
  id?: string;
  conversation: UserConversation;
  highlighted: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      data-testid={`searchbar-group-${conversation.conversationID}`}
      onMouseEnter={onHover}
      onClick={onSelect}
      aria-selected={highlighted}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm mobile:py-3 mobile:text-base ${
        highlighted ? 'bg-muted' : ''
      }`}
    >
      <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="flex-1 truncate font-medium">{conversation.displayName}</span>
    </button>
  );
}

function ChannelRow({
  id,
  hit,
  joined,
  highlighted,
  onHover,
  onSelect,
}: {
  id?: string;
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
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      data-testid={`searchbar-channel-${hit.id}`}
      onMouseEnter={onHover}
      onClick={onSelect}
      aria-selected={highlighted}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm mobile:py-3 mobile:text-base ${
        highlighted ? 'bg-muted' : ''
      }`}
    >
      <ChannelIcon
        type={isPrivate ? 'private' : 'public'}
        className="h-4 w-4 shrink-0 text-muted-foreground"
        ariaLabel=""
      />
      <span className="flex-1 truncate font-medium">~{name}</span>
      {!joined && (
        <Badge variant="outline" className="shrink-0" data-testid={`searchbar-channel-${hit.id}-join`}>
          Join
        </Badge>
      )}
    </button>
  );
}

function UserRow({
  id,
  hit,
  avatarURL,
  userStatus,
  highlighted,
  onHover,
  onSelect,
}: {
  id?: string;
  hit: SearchHit;
  avatarURL?: string;
  userStatus?: UserStatus | null;
  highlighted: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const name = String(hit._source.displayName || hit.id);
  const email = String(hit._source.email ?? '');
  // This row's user only: the bar re-rendered for every presence change.
  const online = useIsOnline(hit.id);
  // Shared canonical people-row — the same element the add-member and
  // new-conversation pickers render, so the design can't drift.
  return (
    <UserPickerRow
      optionId={id}
      testID={`searchbar-user-${hit.id}`}
      displayName={name}
      email={email}
      avatarURL={avatarURL}
      online={online}
      userStatus={userStatus}
      highlighted={highlighted}
      onHover={onHover}
      onSelect={onSelect}
    />
  );
}
