import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import {
  COMMON_EMOJI_SHORTCODES,
  shortcodeWithSkinTone,
  type EmojiSkinTone,
} from '@/lib/emoji-shortcodes';
import { recordEmojiUse } from '@/lib/emoji-frequency';
import { fuzzyMatch } from '@/lib/fuzzy';
import type { CustomEmoji } from '@/types';
import type { MentionCompletion } from './optionRender';

// `:shortcode:` autocomplete for the composer. Selecting an option inserts the
// canonical `:name:` text (with the user's skin-tone suffix for the standard
// set) — the same shortcode form the renderer and the Go validator understand —
// so the document stays portable markdown. Ranking mirrors the old Lexical
// EmojiShortcutsPlugin: custom emoji first, then exact/prefix/substring/fuzzy.

const MAX_EMOJI_RESULTS = 8;

export type EmojiHit =
  | { kind: 'standard'; name: string; unicode: string }
  | { kind: 'custom'; name: string; imageURL: string };

function normalizeEmojiQuery(query: string): string {
  return query.trim().toLowerCase().replace(/^:+|:+$/g, '');
}

function emojiRank(q: string, emoji: { name: string; keywords?: string[] }): number {
  if (emoji.name === q) return 0;
  if (emoji.name.startsWith(q)) return 1;
  if (emoji.name.includes(q)) return 2;
  /* istanbul ignore next -- the generated emoji dataset carries no `keywords`, so this prefix arm is unreachable with the shipped data. */
  if (emoji.keywords?.some((keyword) => keyword.startsWith(q))) return 3;
  if (fuzzyMatch(q, emoji.name, ...(emoji.keywords ?? []))) return 4;
  return Number.POSITIVE_INFINITY;
}

export function rankEmoji(query: string, customEmojis: CustomEmoji[]): EmojiHit[] {
  const q = normalizeEmojiQuery(query);
  const custom: EmojiHit[] = customEmojis
    .filter((e) => fuzzyMatch(q, e.name))
    .slice(0, MAX_EMOJI_RESULTS)
    .map((e) => ({ kind: 'custom', name: e.name, imageURL: e.imageURL }));
  const remaining = MAX_EMOJI_RESULTS - custom.length;
  const standard: EmojiHit[] = COMMON_EMOJI_SHORTCODES
    .map((emoji, index) => ({ emoji, rank: emojiRank(q, emoji), index }))
    .filter((hit) => Number.isFinite(hit.rank))
    .sort((a, b) => a.rank - b.rank || a.emoji.name.length - b.emoji.name.length || a.index - b.index)
    .slice(0, Math.max(0, remaining))
    .map(({ emoji }) => ({ kind: 'standard', name: emoji.name, unicode: emoji.unicode }));
  return [...custom, ...standard];
}

export interface EmojiProviders {
  customEmojis: () => CustomEmoji[];
  skinTone: () => EmojiSkinTone;
}

function applyInsert(text: string, recordAs: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    // Picking from the :-typeahead IS an emoji use — without this, composer
    // picks (the most common way emojis are inserted) never fed the popular
    // shelf and it drifted static. Best-effort, same as the picker.
    void recordEmojiUse(recordAs);
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  };
}

// "EMOJI" header for the :-popup, styled by the shared `.cm-mention-section`.
const EMOJI_SECTION: CompletionSection = {
  name: 'Emoji',
  rank: 0,
  header: () => {
    const el = document.createElement('div');
    el.className = 'cm-mention-section';
    el.textContent = 'Emoji';
    return el;
  },
};

function hitToCompletion(hit: EmojiHit, skinTone: EmojiSkinTone): MentionCompletion {
  if (hit.kind === 'custom') {
    return {
      label: `:${hit.name}:`,
      detail: 'custom',
      type: 'text',
      section: EMOJI_SECTION,
      apply: applyInsert(`:${hit.name}: `, `:${hit.name}:`),
      meta: { kind: 'emoji', name: hit.name, imageURL: hit.imageURL },
    };
  }
  const shortcode = shortcodeWithSkinTone(hit.name, hit.unicode, skinTone);
  return {
    label: `:${hit.name}:`,
    detail: hit.unicode,
    type: 'text',
    section: EMOJI_SECTION,
    apply: applyInsert(`${shortcode} `, shortcode),
    meta: { kind: 'emoji', name: hit.name, glyph: hit.unicode },
  };
}

export function emojiSource(providers: EmojiProviders): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    // Require at least one character after the colon (no popup on a bare `:`),
    // allowing the `_`, `+`, `-` that appear in shortcode names (`:+1:`).
    const before = context.matchBefore(/:[\w+-]+/);
    if (!before) return null;
    const query = before.text.slice(1);
    const skinTone = providers.skinTone();
    const options = rankEmoji(query, providers.customEmojis()).map((h) => hitToCompletion(h, skinTone));
    return { from: before.from, to: before.to, options, filter: false };
  };
}
