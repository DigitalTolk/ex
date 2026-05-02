import { useEffect, useRef, useState, useMemo } from 'react';
import {
  Flag,
  Hash,
  Leaf,
  Package,
  Plane,
  Smile,
  Sparkles,
  Trophy,
  UserRound,
  Utensils,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEmojis } from '@/hooks/useEmoji';
import {
  ALL_EMOJI,
  COMMON_EMOJI_SHORTCODES,
  EMOJI_CATEGORIES,
  EMOJI_SKIN_TONES,
  applyEmojiSkinTone,
  shortcodeWithSkinTone,
  supportsEmojiSkinTone,
  type EmojiSkinTone,
  type EmojiEntry,
} from '@/lib/emoji-shortcodes';
import { PopoverPortal } from '@/components/PopoverPortal';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { fuzzyMatch } from '@/lib/fuzzy';
import { apiFetch, getAccessToken } from '@/lib/api';
import * as AuthContext from '@/context/AuthContext';
import type { User } from '@/types';

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

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  smileys_emotion: Smile,
  people_body: UserRound,
  animals_nature: Leaf,
  food_drink: Utensils,
  travel_places: Plane,
  activities: Trophy,
  objects: Package,
  symbols: Hash,
  flags: Flag,
  custom: Sparkles,
};

const CUSTOM_CATEGORY_SLUG = 'custom';
const PICKER_WIDTH = 336;
const PICKER_HEIGHT = 460;

function normalizeEmojiQuery(query: string) {
  return query.trim().toLowerCase().replace(/^:+|:+$/g, '');
}

function emojiSearchRank(query: string, emoji: { name: string; keywords?: string[] }) {
  const q = normalizeEmojiQuery(query);
  if (!q) return 0;
  if (emoji.name === q) return 0;
  if (emoji.name.startsWith(q)) return 1;
  if (emoji.name.includes(q)) return 2;
  if (emoji.keywords?.some((keyword) => keyword.startsWith(q))) return 3;
  if (fuzzyMatch(q, emoji.name, ...(emoji.keywords ?? []))) return 4;
  return Number.POSITIVE_INFINITY;
}

function useEmojiPickerAuth() {
  try {
    // Test suites often mock AuthContext before mounting isolated message
    // components. Prefer the optional hook in the app, but tolerate older
    // mocks that only provide useAuth.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return AuthContext.useOptionalAuth?.() ?? AuthContext.useAuth();
  } catch {
    return null;
  }
}

export function EmojiPicker({ onSelect, onClose, trigger, ariaLabel = 'Emoji picker' }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>(EMOJI_CATEGORIES[0]?.slug ?? '');
  const auth = useEmojiPickerAuth();
  const user = auth?.user;
  const [skinTone, setSkinTone] = useState<EmojiSkinTone>(user?.emojiSkinTone ?? '');
  const profileSkinToneRef = useRef<EmojiSkinTone>(user?.emojiSkinTone ?? '');
  const triggerRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const categories = useMemo(
    () => [...EMOJI_CATEGORIES, { slug: CUSTOM_CATEGORY_SLUG, label: 'Custom' }],
    [],
  );

  // Lazy: only fetch the custom-emoji list once the picker is open,
  // so closed pickers in 100s of MessageItem rows don't each fire a
  // query on mount and pollute act() in unrelated tests.
  const { data: customEmojis } = useEmojis(open);

  // Searching switches the picker into a flat-results view across
  // every category; clearing the search returns to the active tab.
  // Search runs against the same generated standard catalog used by
  // typeahead and native emoji normalization.
  const filteredStandard = useMemo(() => {
    if (!query.trim() && activeCategory === CUSTOM_CATEGORY_SLUG) return [];
    if (!query.trim()) return EMOJIS_BY_CATEGORY[activeCategory] ?? [];
    return COMMON_EMOJI_SHORTCODES
      .map((emoji, index) => ({ emoji, rank: emojiSearchRank(query, emoji), index }))
      .filter((hit) => Number.isFinite(hit.rank))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((hit) => hit.emoji);
  }, [query, activeCategory]);

  const filteredCustom = useMemo(() => {
    if (!customEmojis) return [];
    if (!query.trim() && activeCategory !== CUSTOM_CATEGORY_SLUG) return [];
    if (!query.trim()) return customEmojis;
    return customEmojis.filter((e) => fuzzyMatch(query, e.name));
  }, [activeCategory, customEmojis, query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!user) return;
    const next = user?.emojiSkinTone ?? '';
    if (profileSkinToneRef.current === next) return;
    profileSkinToneRef.current = next;
    queueMicrotask(() => setSkinTone(next));
  }, [open, user]);

  function close() {
    setOpen(false);
    setQuery('');
    onClose?.();
  }

  function handlePick(shortcode: string) {
    onSelect(shortcode);
    close();
  }

  async function handleSkinToneChange(next: EmojiSkinTone) {
    const prev = skinTone;
    setSkinTone(next);
    if (!user || next === user.emojiSkinTone) return;
    try {
      const updated = await apiFetch<User>('/api/v1/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ emojiSkinTone: next }),
      });
      const token = getAccessToken();
      if (token) auth?.setAuth(token, updated);
    } catch {
      setSkinTone(prev);
    }
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
        estimatedHeight={PICKER_HEIGHT}
        estimatedWidth={PICKER_WIDTH}
        preferredSide="bottom"
        preferredAlign="end"
        ariaLabel={ariaLabel}
        className="flex h-[460px] w-[336px] max-w-[calc(100vw-16px)] flex-col rounded-md border bg-popover p-2 shadow-md"
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emojis..."
          aria-label="Search emojis"
          className="mb-1.5 h-8 shrink-0 text-sm"
        />
        {!query.trim() && (
          <div
            className="mb-1.5 flex shrink-0 justify-center gap-0.5 border-b pb-1"
            role="tablist"
            aria-label="Emoji categories"
          >
            {categories.map((c) => {
              const selected = c.slug === activeCategory;
              const Icon = CATEGORY_ICONS[c.slug] ?? Hash;
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
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground ' +
                    (selected ? 'bg-muted text-foreground' : 'hover:bg-muted/60 hover:text-foreground')
                  }
                >
                  <Icon className="size-4" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        <div className="mb-1.5 flex shrink-0 items-center gap-0.5" role="radiogroup" aria-label="Emoji skin tone">
          <span className="mr-1 text-xs font-medium text-muted-foreground">Skin tone</span>
          {EMOJI_SKIN_TONES.map((tone) => (
            <button
              key={tone.value || 'default'}
              type="button"
              role="radio"
              aria-checked={skinTone === tone.value}
              aria-label={tone.label}
              title={tone.label}
              onClick={() => void handleSkinToneChange(tone.value)}
              className={
                'flex h-7 w-7 items-center justify-center rounded-md text-base hover:bg-muted ' +
                (skinTone === tone.value ? 'bg-muted ring-1 ring-ring' : '')
              }
            >
              {tone.swatch}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {query.trim()
              ? 'Results'
              : activeCategory === CUSTOM_CATEGORY_SLUG
                ? 'Custom'
                : EMOJI_CATEGORIES.find((c) => c.slug === activeCategory)?.label ?? 'Standard'}
          </div>
          <div
            className="grid min-h-0 flex-1 grid-cols-[repeat(9,2rem)] content-start justify-center gap-0.5 overflow-y-auto"
            role="list"
            aria-label={activeCategory === CUSTOM_CATEGORY_SLUG && !query.trim() ? 'Custom emojis' : 'Standard emojis'}
          >
            {filteredCustom.map((e) => (
              <button
                key={`custom-${e.name}`}
                type="button"
                role="listitem"
                data-testid="emoji-picker-tile"
                onClick={() => handlePick(`:${e.name}:`)}
                className="flex h-8 w-8 items-center justify-center rounded hover:bg-muted"
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
            {filteredStandard.map((e) => {
              const tonedEmoji = applyEmojiSkinTone(e.unicode, skinTone);
              const shortcode = shortcodeWithSkinTone(e.name, e.unicode, skinTone);
              return (
                <button
                  key={`standard-${e.name}`}
                  type="button"
                  role="listitem"
                  data-testid="emoji-picker-tile"
                  onClick={() => handlePick(shortcode)}
                  className="flex h-8 w-8 items-center justify-center rounded hover:bg-muted"
                  aria-label={`React with ${shortcode}`}
                  title={shortcode}
                >
                  <EmojiGlyph
                    emoji={supportsEmojiSkinTone(e.unicode) ? tonedEmoji : e.unicode}
                    size="lg"
                  />
                </button>
              );
            })}
            {filteredStandard.length === 0 && filteredCustom.length === 0 && (
              <p className="col-span-9 py-3 text-center text-xs text-muted-foreground">No emojis found</p>
            )}
          </div>
        </div>
      </PopoverPortal>
    </>
  );
}
