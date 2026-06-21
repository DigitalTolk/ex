import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, FileSearch, X } from 'lucide-react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useChannelBySlug } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';

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

// SearchBar — Slack-style. Typing opens a dropdown of suggestions:
//  1. Show results for: <q>          (always present)
//  2. Search results in <~channel>   (only on /channel/:slug)
//  3. Search results in this DM/group(only on /conversation/:id)
// ArrowUp/Down cycles, Enter submits the highlighted suggestion, Esc
// closes. Empty input → no dropdown.
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

  const suggestions = useMemo<Suggestion[]>(() => {
    const trimmed = q.trim();
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
  }, [q, currentChannel, currentConversation]);

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

  // Clamp the highlighted index in case the suggestion list shrank.
  const safeHighlight = highlight >= suggestions.length ? 0 : highlight;

  function submit(idx = safeHighlight) {
    const trimmed = q.trim();
    if (!trimmed) return;
    /* istanbul ignore next -- safeHighlight is clamped in-range, so suggestions[idx] is always defined; the ?? fallback and the !sel guard below are defensive (a non-empty query always yields >= 1 suggestion) */
    const sel = suggestions[idx] ?? suggestions[0];
    /* istanbul ignore next -- defensive: a non-empty query always yields at least the "all" suggestion, so sel is never falsy here */
    if (!sel) return;
    setOpen(false);
    inputRef.current?.blur();
    const params = new URLSearchParams({ q: trimmed });
    if (sel.kind === 'in-scope') {
      params.set('in', sel.parentId);
      // Land directly on the tab that matches the scope so the user
      // sees the right results immediately, skipping All tab's noise
      // from Channels/People. Channels → "messages"; DMs/groups →
      // "dms" (the DMs tab is filtered to parentType=conversation).
      params.set('type', sel.scopeKind === 'channel' ? 'messages' : 'dms');
    }
    navigate(`/search?${params.toString()}`);
    setQ('');
    setHighlight(0);
  }

  function clear() {
    setQ('');
    inputRef.current?.focus();
  }

  const showDropdown = open && suggestions.length > 0;

  return (
    <div ref={containerRef} className="relative w-full" data-testid="searchbar">
      {/* Rectangular global search per the design — rounded-md
          corners (6px), subtle 1px border, search glyph on the left,
          "Search for anything" placeholder. Solid token surfaces: base
          bg in light, the level3 muted surface in dark (so it lifts off
          the level1 header), never a glassy white wash. */}
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
              submit();
            } else if (e.key === 'Escape') {
              setOpen(false);
              inputRef.current?.blur();
            } else if (e.key === 'ArrowDown') {
              if (suggestions.length === 0) return;
              e.preventDefault();
              setHighlight((p) => (p + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp') {
              if (suggestions.length === 0) return;
              e.preventDefault();
              setHighlight((p) => (p - 1 + suggestions.length) % suggestions.length);
            }
          }}
          placeholder="Search for anything"
          aria-label="Search"
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none max-md:text-base"
          data-testid="searchbar-input"
        />
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
      {showDropdown && (
        <div
          role="listbox"
          data-testid="searchbar-dropdown"
          className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg"
        >
          {suggestions.map((s, i) => {
            const isHighlighted = i === safeHighlight;
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
                ? `Show results in this ${scopeNoun} for: `
                : `Show results for: `;
            return (
              <button
                key={s.kind === 'in-scope' ? `in-${s.scopeKind}` : 'all'}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => submit(i)}
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
      )}
    </div>
  );
}
