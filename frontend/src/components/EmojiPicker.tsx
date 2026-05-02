import { useEffect, useRef, useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEmojis } from '@/hooks/useEmoji';
import {
  ALL_EMOJI,
  COMMON_EMOJI_SHORTCODES,
  EMOJI_CATEGORIES,
  type EmojiEntry,
} from '@/lib/emoji-shortcodes';
import { PopoverPortal } from '@/components/PopoverPortal';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { fuzzyMatch } from '@/lib/fuzzy';

type SelectMode = 'shortcode' | 'reaction';

interface EmojiPickerProps {
  // Called when the user picks an emoji. The string is always a `:shortcode:`
  // (so messages and reactions are stored uniformly per the API contract).
  onSelect: (shortcode: string) => void;
  onClose?: () => void;
  trigger?: React.ReactNode;
  ariaLabel?: string;
  // shortcode: insert :name: into a textarea (for the message composer)
  // reaction: emit :name: too — handled identically here
  mode?: SelectMode;
}

// Emojis grouped by their CLDR category. Memoized at module load so
// the picker doesn't re-bucket 1900 entries on every open.
const EMOJIS_BY_CATEGORY: Record<string, EmojiEntry[]> = (() => {
  const map: Record<string, EmojiEntry[]> = {};
  for (const c of EMOJI_CATEGORIES) map[c.slug] = [];
  for (const e of ALL_EMOJI) {
    (map[e.category] ??= []).push(e);
  }
  return map;
})();

export function EmojiPicker({ onSelect, onClose, trigger, ariaLabel = 'Emoji picker' }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>(EMOJI_CATEGORIES[0]?.slug ?? '');
  const triggerRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lazy: only fetch the custom-emoji list once the picker is open,
  // so closed pickers in 100s of MessageItem rows don't each fire a
  // query on mount and pollute act() in unrelated tests.
  const { data: customEmojis } = useEmojis(open);

  // Searching switches the picker into a flat-results view across
  // every category; clearing the search returns to the active tab.
  // Search must run against COMMON_EMOJI_SHORTCODES so legacy
  // GitHub-style aliases (`:thumbsup:`, `:tada:`, `:smile:`) surface
  // alongside the CLDR slugs and stored messages keep round-tripping.
  const filteredStandard = useMemo(() => {
    if (!query.trim()) return EMOJIS_BY_CATEGORY[activeCategory] ?? [];
    return COMMON_EMOJI_SHORTCODES.filter((e) =>
      fuzzyMatch(query, e.name, e.unicode, ...(e.keywords ?? [])),
    );
  }, [query, activeCategory]);

  const filteredCustom = useMemo(() => {
    if (!customEmojis) return [];
    if (!query.trim()) return customEmojis;
    return customEmojis.filter((e) => fuzzyMatch(query, e.name));
  }, [customEmojis, query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
    onClose?.();
  }

  function handlePick(shortcode: string) {
    onSelect(shortcode);
    close();
  }

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-block"
        onClick={() => setOpen((v) => !v)}
      >
        {trigger ?? (
          <Button size="sm" variant="ghost" aria-label="Open emoji picker">
            😊
          </Button>
        )}
      </span>
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={close}
        estimatedHeight={420}
        estimatedWidth={336}
        preferredSide="bottom"
        preferredAlign="end"
        ariaLabel={ariaLabel}
        className="w-[336px] rounded-md border bg-popover p-3 shadow-md"
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emojis..."
          aria-label="Search emojis"
          className="mb-2 h-9 text-sm"
        />
        {!query.trim() && (
          <div
            className="mb-2 flex gap-0.5 overflow-x-auto border-b pb-1"
            role="tablist"
            aria-label="Emoji categories"
          >
            {EMOJI_CATEGORIES.map((c) => {
              const sample = EMOJIS_BY_CATEGORY[c.slug]?.[0]?.unicode ?? '•';
              const selected = c.slug === activeCategory;
              return (
                <button
                  key={c.slug}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-testid="emoji-category-tab"
                  data-category={c.slug}
                  onClick={() => setActiveCategory(c.slug)}
                  title={c.label}
                  className={
                    'h-7 w-7 shrink-0 rounded-md flex items-center justify-center text-base ' +
                    (selected ? 'bg-muted' : 'hover:bg-muted/60')
                  }
                >
                  <EmojiGlyph emoji={sample} />
                </button>
              );
            })}
          </div>
        )}
        {filteredCustom.length > 0 && (
          <div className="mb-2">
            <div className="mb-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Custom
            </div>
            <div className="grid grid-cols-7 gap-1" role="list" aria-label="Custom emojis">
              {filteredCustom.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  role="listitem"
                  data-testid="emoji-picker-tile"
                  onClick={() => handlePick(`:${e.name}:`)}
                  className="h-9 w-9 rounded hover:bg-muted flex items-center justify-center"
                  aria-label={`React with :${e.name}:`}
                  title={`:${e.name}:`}
                >
                  <EmojiGlyph
                    emoji={`:${e.name}:`}
                    customMap={{ [e.name]: e.imageURL }}
                    size="lg"
                  />
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="mb-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {query.trim()
              ? 'Results'
              : EMOJI_CATEGORIES.find((c) => c.slug === activeCategory)?.label ?? 'Standard'}
          </div>
          <div
            className="grid grid-cols-7 gap-1 max-h-64 overflow-y-auto"
            role="list"
            aria-label="Standard emojis"
          >
            {filteredStandard.map((e) => (
              <button
                key={e.name}
                type="button"
                role="listitem"
                data-testid="emoji-picker-tile"
                onClick={() => handlePick(`:${e.name}:`)}
                className="h-9 w-9 rounded hover:bg-muted flex items-center justify-center"
                aria-label={`React with :${e.name}:`}
                title={`:${e.name}:`}
              >
                <EmojiGlyph emoji={e.unicode} size="lg" />
              </button>
            ))}
          </div>
          {filteredStandard.length === 0 && filteredCustom.length === 0 && (
            <p className="py-3 text-center text-xs text-muted-foreground">No emojis found</p>
          )}
        </div>
      </PopoverPortal>
    </>
  );
}
