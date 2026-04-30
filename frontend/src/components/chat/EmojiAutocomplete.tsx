import { useEffect, useMemo, useRef, useState } from 'react';
import { COMMON_EMOJI_SHORTCODES } from '@/lib/emoji-shortcodes';
import { useEmojis } from '@/hooks/useEmoji';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { fuzzyMatch } from '@/lib/fuzzy';

// EmojiSuggestion is what the editor inserts. Custom emojis carry an
// imageURL so the popup row can preview them; standard ones use the
// unicode glyph.
export type EmojiSuggestion =
  | { kind: 'standard'; name: string; unicode: string }
  | { kind: 'custom'; name: string; imageURL: string };

interface Props {
  // Text the user typed after the `:` trigger (lowercased for matching).
  query: string;
  // Anchor for positioning — the popup appears just above the caret.
  anchorRect: DOMRect | null;
  onPick: (s: EmojiSuggestion) => void;
  onDismiss: () => void;
}

const MAX_SUGGESTIONS = 8;

export function EmojiAutocomplete({ query, anchorRect, onPick, onDismiss }: Props) {
  const { data: customEmojis } = useEmojis();
  const [active, setActive] = useState(0);

  const items: EmojiSuggestion[] = useMemo(() => {
    if (!query.trim()) return [];
    const customMatches = (customEmojis ?? [])
      .filter((e) => fuzzyMatch(query, e.name))
      .slice(0, MAX_SUGGESTIONS)
      .map((e): EmojiSuggestion => ({ kind: 'custom', name: e.name, imageURL: e.imageURL }));
    const remaining = MAX_SUGGESTIONS - customMatches.length;
    const standardMatches = COMMON_EMOJI_SHORTCODES
      .filter((e) => fuzzyMatch(query, e.name, ...(e.keywords ?? [])))
      .slice(0, Math.max(0, remaining))
      .map((e): EmojiSuggestion => ({ kind: 'standard', name: e.name, unicode: e.unicode }));
    return [...customMatches, ...standardMatches];
  }, [query, customEmojis]);

  // Reset highlight whenever the suggestion list changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(0);
  }, [items.length]);

  // Keyboard handling — the editor surrenders Up/Down/Enter/Tab/Escape
  // while this popup is open.
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
      data-testid="emoji-autocomplete"
      role="listbox"
      aria-label="Emoji suggestions"
      style={style}
      className="w-72 max-w-[90vw] rounded-md border bg-popover p-1 shadow-lg"
    >
      {items.map((it, i) => {
        const isActive = i === active;
        return (
          <button
            key={`${it.kind}-${it.name}`}
            type="button"
            role="option"
            aria-selected={isActive}
            data-testid="emoji-autocomplete-option"
            data-emoji-active={isActive ? 'true' : 'false'}
            onMouseDown={(e) => {
              // mousedown so we beat the editor's blur — picking
              // shouldn't depend on whether the user clicks before or
              // after focus drifts.
              e.preventDefault();
              onPick(it);
            }}
            onMouseEnter={() => setActive(i)}
            className={
              'flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-sm ' +
              (isActive ? 'bg-muted' : 'hover:bg-muted/50')
            }
          >
            <span className="flex h-5 w-5 items-center justify-center">
              {it.kind === 'standard' ? (
                <EmojiGlyph emoji={it.unicode} />
              ) : (
                <img src={it.imageURL} alt="" className="h-5 w-5" />
              )}
            </span>
            <span className="font-mono text-xs">:{it.name}:</span>
          </button>
        );
      })}
    </div>
  );
}
