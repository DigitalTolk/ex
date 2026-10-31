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
// so the document stays portable markdown. Standard and custom emoji rank
// together: exact, prefix, substring, then fuzzy matches, the standard emoji
// first among equals — `:eyes` is 👀 before any custom emoji that merely
// resembles it.

// The popup scrolls; this only bounds the work of a broad query.
const MAX_EMOJI_RESULTS = 50;

// The popup opens on a `:` that starts a word — not the one in a time like
// 10:30 — once two characters follow it: `:p` is left to show as 😛 once the
// space after it is typed (./emojiGlyphs), `:po` opens it. Once open it stays open down
// to one character, so backspacing a typo doesn't close it.
const EMOJI_QUERY_RE = /(?:^|[^a-z0-9]):[\w+-]{2,}/i;
const OPEN_EMOJI_QUERY_RE = /(?:^|[^a-z0-9]):[\w+-]+/i;

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

interface RankedHit {
  hit: EmojiHit;
  rank: number;
  // 0 for a standard emoji, 1 for a custom one: standard first among equals.
  custom: number;
  index: number;
}

export function rankEmoji(query: string, customEmojis: CustomEmoji[]): EmojiHit[] {
  const q = normalizeEmojiQuery(query);
  const ranked: RankedHit[] = [
    ...COMMON_EMOJI_SHORTCODES.map((emoji, index) => ({
      hit: { kind: 'standard' as const, name: emoji.name, unicode: emoji.unicode },
      rank: emojiRank(q, emoji),
      custom: 0,
      index,
    })),
    ...customEmojis.map((emoji, index) => ({
      hit: { kind: 'custom' as const, name: emoji.name, imageURL: emoji.imageURL },
      rank: emojiRank(q, emoji),
      custom: 1,
      index,
    })),
  ];
  return ranked
    .filter((r) => Number.isFinite(r.rank))
    .sort((a, b) => a.rank - b.rank || a.custom - b.custom || a.hit.name.length - b.hit.name.length || a.index - b.index)
    .slice(0, MAX_EMOJI_RESULTS)
    .map((r) => r.hit);
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
  const complete = (context: CompletionContext, query: RegExp): CompletionResult | null => {
    // The query allows the `_`, `+`, `-` that appear in shortcode names
    // (`:+1:`); the match may start with the character before the colon.
    const before = context.matchBefore(query);
    if (!before) return null;
    const colon = before.text.lastIndexOf(':');
    const skinTone = providers.skinTone();
    const options = rankEmoji(before.text.slice(colon + 1), providers.customEmojis()).map((h) =>
      hitToCompletion(h, skinTone),
    );
    return {
      from: before.from + colon,
      to: before.to,
      options,
      filter: false,
      // CodeMirror asks an open result to update itself as the query changes.
      update: (_result, _from, _to, next) => complete(next, OPEN_EMOJI_QUERY_RE),
    };
  };
  return (context) => complete(context, EMOJI_QUERY_RE);
}
