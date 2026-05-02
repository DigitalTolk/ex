// Build the full emoji dataset from unicode-emoji-json into a static
// TypeScript file at src/lib/emoji-data.generated.ts.
//
// Run via:  node scripts/build-emoji-data.mjs
//
// Re-run after bumping the unicode-emoji-json package to pick up new
// codepoints. The output is committed so production doesn't depend on
// node_modules at runtime.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import groups from 'unicode-emoji-json/data-by-group.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '..', 'src', 'lib', 'emoji-data.generated.ts');
const MAX_EMOJI_NAME_LENGTH = 32;
const EMOJI_MODIFIER_BASE_RE = /^\p{Emoji_Modifier_Base}/u;
const EMOJI_MODIFIER_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const ZERO_WIDTH_JOINER = '\u200D';

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'the', 'with']);
const WORD_REPLACEMENTS = new Map([
  ['anticlockwise', 'anti'],
  ['application', 'app'],
  ['background', 'bg'],
  ['backhand', 'back'],
  ['beaming', 'beam'],
  ['blood', 'bld'],
  ['blowing', 'blow'],
  ['business', 'biz'],
  ['button', 'btn'],
  ['charge', 'chg'],
  ['closed', 'clsd'],
  ['congratulations', 'congrats'],
  ['counterclockwise', 'counter'],
  ['crossed', 'cross'],
  ['decorative', 'decor'],
  ['diagonal', 'diag'],
  ['exclamation', 'bang'],
  ['expressionless', 'blank'],
  ['fingers', 'fngr'],
  ['frowning', 'frown'],
  ['gesturing', 'gest'],
  ['grinning', 'grin'],
  ['headphone', 'headset'],
  ['horizontally', 'horiz'],
  ['information', 'info'],
  ['japanese', 'jp'],
  ['laughing', 'laugh'],
  ['lightning', 'bolt'],
  ['lowered', 'low'],
  ['magnifying', 'mag'],
  ['motorized', 'motor'],
  ['mountain', 'mtn'],
  ['mouth', 'mouth'],
  ['person', 'person'],
  ['pointing', 'point'],
  ['prohibited', 'ban'],
  ['question', 'q'],
  ['raised', 'raise'],
  ['relieved', 'relief'],
  ['sandwich', 'sandwich'],
  ['service', 'svc'],
  ['shaking', 'shake'],
  ['smiling', 'smile'],
  ['squinting', 'squint'],
  ['territories', 'terr'],
  ['thermometer', 'thermo'],
  ['thumb', 'thmb'],
  ['tongue', 'tongue'],
  ['vertically', 'vert'],
  ['wheelchair', 'wheelchair'],
]);

const NAME_OVERRIDES = new Map([
  ['grinning_face_with_smiling_eyes', 'smile'],
  ['grinning_squinting_face', 'laughing'],
  ['face_with_tears_of_joy', 'joy'],
  ['smiling_face_with_heart_eyes', 'heart_eyes'],
  ['red_heart', 'heart'],
  ['hundred_points', '100'],
  ['waving_hand', 'wave'],
  ['clapping_hands', 'clap'],
  ['folded_hands', 'pray'],
  ['party_popper', 'tada'],
  ['hand_with_fingers_splayed', 'hand'],
  ['raising_hands', 'raised_hands'],
  ['thumbs_up', 'thumbsup'],
  ['thumbs_down', 'thumbsdown'],
]);

function supportsEmojiSkinTone(emoji) {
  if (emoji.includes(ZERO_WIDTH_JOINER)) return false;
  const first = Array.from(emoji.replace(EMOJI_MODIFIER_RE, ''))[0] ?? '';
  return !!first && EMOJI_MODIFIER_BASE_RE.test(first);
}

function hashSlug(slug) {
  let hash = 5381;
  for (const ch of slug) hash = ((hash << 5) + hash) ^ ch.codePointAt(0);
  return (hash >>> 0).toString(36).slice(0, 4);
}

function clampWithHash(candidate, source, maxLength) {
  const suffix = hashSlug(source);
  const prefix = candidate
    .slice(0, Math.max(1, maxLength - suffix.length - 1))
    .replace(/[_+-]+$/g, '');
  return `${prefix}_${suffix}`;
}

function compactEmojiName(slug, emoji) {
  const maxLength = MAX_EMOJI_NAME_LENGTH;
  const override = NAME_OVERRIDES.get(slug);
  if (override) return override;

  const words = slug
    .split('_')
    .filter((word) => !STOP_WORDS.has(word))
    .map((word) => WORD_REPLACEMENTS.get(word) ?? word);

  let candidate = words.join('_');
  if (candidate.length <= maxLength) return candidate;

  for (const wordLength of [8, 6, 5, 4, 3]) {
    candidate = words.map((word) => (word.length > wordLength ? word.slice(0, wordLength) : word)).join('_');
    if (candidate.length <= maxLength) return candidate;
  }

  candidate = words.map((word) => word[0]).join('_');
  if (candidate.length <= maxLength) return candidate;
  return clampWithHash(candidate, slug, maxLength);
}

function uniqueEmojiName(slug, emoji, usedNames) {
  const maxLength = MAX_EMOJI_NAME_LENGTH;
  let name = compactEmojiName(slug, emoji);
  if (name.length > maxLength) name = clampWithHash(name, slug, maxLength);
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }

  name = clampWithHash(name, slug, maxLength);
  let i = 2;
  while (usedNames.has(name)) {
    const suffix = `_${i}`;
    const base = name.slice(0, maxLength - suffix.length).replace(/[_+-]+$/g, '');
    name = `${base}${suffix}`;
    i += 1;
  }
  usedNames.add(name);
  return name;
}

// Concise category labels — what the picker tabs render. The slug
// matches unicode-emoji-json so the categories stay stable across
// dataset bumps.
const CATEGORIES = groups.map((g) => ({
  slug: g.slug,
  label: g.name,
  count: g.emojis.length,
}));

const lines = [];
lines.push('// AUTO-GENERATED by scripts/build-emoji-data.mjs — DO NOT EDIT BY HAND.');
lines.push('// Source: unicode-emoji-json (CLDR data).');
lines.push('');
lines.push('export interface EmojiEntry {');
lines.push('  name: string;');
lines.push('  unicode: string;');
lines.push('  category: string;');
lines.push('}');
lines.push('');
lines.push('export interface EmojiCategory {');
lines.push('  slug: string;');
lines.push('  label: string;');
lines.push('}');
lines.push('');
lines.push('export const EMOJI_CATEGORIES: EmojiCategory[] = [');
for (const c of CATEGORIES) {
  lines.push(`  { slug: ${JSON.stringify(c.slug)}, label: ${JSON.stringify(c.label)} },`);
}
lines.push('];');
lines.push('');
lines.push('export const ALL_EMOJI: EmojiEntry[] = [');
const usedNames = new Set();
for (const g of groups) {
  for (const e of g.emojis) {
    const name = uniqueEmojiName(e.slug, e.emoji, usedNames);
    if (name.length > MAX_EMOJI_NAME_LENGTH) {
      throw new Error(`${e.slug} generated overlong emoji name ${name}`);
    }
    lines.push(
      `  { name: ${JSON.stringify(name)}, unicode: ${JSON.stringify(e.emoji)}, category: ${JSON.stringify(g.slug)} },`,
    );
  }
}
lines.push('];');
lines.push('');

writeFileSync(outPath, lines.join('\n'));
console.log(`wrote ${outPath} (${groups.reduce((a, b) => a + b.emojis.length, 0)} emojis)`);
