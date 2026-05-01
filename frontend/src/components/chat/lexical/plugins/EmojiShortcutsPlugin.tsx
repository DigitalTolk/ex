import { useCallback, useMemo, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createTextNode, COMMAND_PRIORITY_NORMAL, type TextNode } from 'lexical';
import { useEmojis } from '@/hooks/useEmoji';
import { COMMON_EMOJI_SHORTCODES } from '@/lib/emoji-shortcodes';
import { fuzzyMatch } from '@/lib/fuzzy';

import { TypeaheadMenu } from './TypeaheadMenu';

const MAX_RESULTS = 8;

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

  const options = useMemo<EmojiOption[]>(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    const custom: EmojiHit[] = customEmojis
      .filter((e) => fuzzyMatch(q, e.name))
      .slice(0, MAX_RESULTS)
      .map((e) => ({ kind: 'custom' as const, name: e.name, imageURL: e.imageURL }));
    const remaining = MAX_RESULTS - custom.length;
    const standard: EmojiHit[] = COMMON_EMOJI_SHORTCODES
      .filter((e) => fuzzyMatch(q, e.name, ...(e.keywords ?? [])))
      .slice(0, Math.max(0, remaining))
      .map((e) => ({ kind: 'standard' as const, name: e.name, unicode: e.unicode }));
    return [...custom, ...standard].map((h) => new EmojiOption(h));
  }, [customEmojis, query]);

  const triggerFn = useBasicTypeaheadTriggerMatch(':', { minLength: 1 });

  const onSelectOption = useCallback(
    (selectedOption: EmojiOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const node = $createTextNode(`:${selectedOption.hit.name}: `);
        nodeToReplace?.replace(node);
        // Park the caret at the END of the inserted shortcode + space.
        // Without this, Lexical leaves the selection wherever it was
        // inside the now-removed `:smi` node — the caret visually lands
        // mid-word and the popup re-resolves before close fully runs.
        node.select(node.getTextContentSize(), node.getTextContentSize());
        closeMenu();
      });
    },
    [editor],
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
            renderRow={(option) => <EmojiRow hit={option.hit} />}
          />
        ) : null
      }
    />
  );
}

function EmojiRow({ hit }: { hit: EmojiHit }) {
  return (
    <div className="flex items-center gap-2" data-testid="emoji-option">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-base" aria-hidden>
        {hit.kind === 'standard' ? hit.unicode : (
          <img src={hit.imageURL} alt="" className="h-5 w-5 rounded-sm object-cover" />
        )}
      </span>
      <div className="min-w-0 flex-1 truncate text-sm">:{hit.name}:</div>
    </div>
  );
}
