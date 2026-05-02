import { useCallback, useMemo, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  PUNCTUATION,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createTextNode, COMMAND_PRIORITY_NORMAL, type TextNode } from 'lexical';
import { useEmojis } from '@/hooks/useEmoji';
import {
  COMMON_EMOJI_SHORTCODES,
  applyEmojiSkinTone,
  shortcodeWithSkinTone,
  supportsEmojiSkinTone,
  type EmojiSkinTone,
} from '@/lib/emoji-shortcodes';
import { fuzzyMatch } from '@/lib/fuzzy';
import { useOptionalAuth } from '@/context/AuthContext';

import { TypeaheadMenu } from './TypeaheadMenu';

const MAX_RESULTS = 8;
const EMOJI_TYPEAHEAD_PUNCTUATION = PUNCTUATION.replace(/[+_-]/g, '');

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

type EmojiHit =
  | { kind: 'standard'; name: string; unicode: string }
  | { kind: 'custom'; name: string; imageURL: string };

class EmojiOption extends MenuOption {
  readonly hit: EmojiHit;
  constructor(hit: EmojiHit) {
    super(`e-${hit.kind}-${hit.name}`);
    this.hit = hit;
  }
}

export function EmojiShortcutsPlugin() {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const { data: customEmojis = [] } = useEmojis();
  const auth = useOptionalAuth();
  const skinTone: EmojiSkinTone = auth?.user?.emojiSkinTone ?? '';

  const options = useMemo<EmojiOption[]>(() => {
    if (!query) return [];
    const q = normalizeEmojiQuery(query);
    const custom: EmojiHit[] = customEmojis
      .filter((e) => fuzzyMatch(q, e.name))
      .slice(0, MAX_RESULTS)
      .map((e) => ({ kind: 'custom' as const, name: e.name, imageURL: e.imageURL }));
    const remaining = MAX_RESULTS - custom.length;
    const standard: EmojiHit[] = COMMON_EMOJI_SHORTCODES
      .map((emoji, index) => ({ emoji, rank: emojiSearchRank(q, emoji), index }))
      .filter((hit) => Number.isFinite(hit.rank))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, Math.max(0, remaining))
      .map(({ emoji }) => ({ kind: 'standard' as const, name: emoji.name, unicode: emoji.unicode }));
    return [...custom, ...standard].map((h) => new EmojiOption(h));
  }, [customEmojis, query]);

  const triggerFn = useBasicTypeaheadTriggerMatch(':', {
    minLength: 1,
    punctuation: EMOJI_TYPEAHEAD_PUNCTUATION,
  });

  const onSelectOption = useCallback(
    (selectedOption: EmojiOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const hit = selectedOption.hit;
        const shortcode = hit.kind === 'standard'
          ? shortcodeWithSkinTone(hit.name, hit.unicode, skinTone)
          : `:${hit.name}:`;
        const node = $createTextNode(`${shortcode} `);
        nodeToReplace?.replace(node);
        // Park the caret at the END of the inserted shortcode + space.
        // Without this, Lexical leaves the selection wherever it was
        // inside the now-removed `:smi` node — the caret visually lands
        // mid-word and the popup re-resolves before close fully runs.
        node.select(node.getTextContentSize(), node.getTextContentSize());
        closeMenu();
      });
    },
    [editor, skinTone],
  );

  return (
    <LexicalTypeaheadMenuPlugin<EmojiOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      options={options}
      // See UserMentionsPlugin for the priority rationale.
      commandPriority={COMMAND_PRIORITY_NORMAL}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorElementRef.current ? (
          <TypeaheadMenu
            testId="emoji-popup"
            emptyLabel={query?.length ? 'No emoji matches' : undefined}
            options={options}
            selectedIndex={selectedIndex}
            setHighlightedIndex={setHighlightedIndex}
            selectOptionAndCleanUp={selectOptionAndCleanUp}
            anchorElementRef={anchorElementRef}
            renderRow={(option) => <EmojiRow hit={option.hit} skinTone={skinTone} />}
          />
        ) : null
      }
    />
  );
}

function EmojiRow({ hit, skinTone }: { hit: EmojiHit; skinTone: EmojiSkinTone }) {
  if (hit.kind === 'custom') {
    return (
      <div className="flex items-center gap-2" data-testid="emoji-option">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-base" aria-hidden>
          <img src={hit.imageURL} alt="" className="h-5 w-5 rounded-sm object-cover" />
        </span>
        <div className="min-w-0 flex-1 truncate text-sm">:{hit.name}:</div>
      </div>
    );
  }
  const preview = supportsEmojiSkinTone(hit.unicode)
    ? applyEmojiSkinTone(hit.unicode, skinTone)
    : hit.unicode;
  return (
    <div className="flex items-center gap-2" data-testid="emoji-option">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-base" aria-hidden>
        {preview}
      </span>
      <div className="min-w-0 flex-1 truncate text-sm">:{hit.name}:</div>
    </div>
  );
}
