import { USER_MENTION_RE_GLOBAL, CHANNEL_MENTION_RE_GLOBAL } from './mention-syntax';
import { EMOJI_SHORTCODE_RE_GLOBAL, shortcodeToUnicode } from './emoji-shortcodes';

// renderEmojiGlyphs replaces every known :shortcode: (and toned
// :name::skin-tone-N:) with its unicode glyph, leaving unknown/custom shortcodes
// untouched. The base glyph is used (the skin-tone modifier is dropped) — for a
// flat plain-text preview, per-tone styling isn't meaningful.
function renderEmojiGlyphs(text: string): string {
  return text.replace(EMOJI_SHORTCODE_RE_GLOBAL, (full, name: string) => {
    const glyph = shortcodeToUnicode(`:${name.toLowerCase()}:`);
    return glyph === `:${name.toLowerCase()}:` ? full : glyph;
  });
}

// toPlainTextPreview flattens a stored message body into readable one-line text
// for surfaces that show a preview WITHOUT the full markdown renderer (e.g. the
// drafts list). It mirrors the backend notification `previewBody`:
//   - user mentions    `@[userID|DisplayName]` → `@DisplayName`
//   - channel mentions `~[channelID|slug]`     → `~slug`
//   - emoji shortcodes `:smile:` (and toned)   → the glyph (unknown left as-is)
//   - collapses whitespace/newlines to single spaces
//
// Surfaces that DO render markdown (the message list, search hits, unfurls) must
// keep using renderMarkdown — this is only for plain-text/truncated previews.
export function toPlainTextPreview(body: string): string {
  const flattened = body
    .replace(USER_MENTION_RE_GLOBAL, '@$2')
    .replace(CHANNEL_MENTION_RE_GLOBAL, '~$2');
  return renderEmojiGlyphs(flattened).replace(/\s+/g, ' ').trim();
}
