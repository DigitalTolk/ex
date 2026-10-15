import slugify from '@sindresorhus/slugify';

// A channel name is a slug (CHANNEL_NAME_PATTERN in ./limits): lowercase ASCII
// letters, digits and single hyphens. People type titles, so the create dialog
// turns what they type into one as they type it — "Marketing Team" becomes
// "marketing-team", "Försäljning Q3" becomes "forsaljning-q3".

// The library writes ä, ö and ü the German way (ae, oe, ue) unless a locale
// says otherwise, which reads wrong in every other language that has them:
// "foersaeljning" for Swedish "försäljning". Outside German they lose their
// dots instead, as in most slug rules. (Custom replacements outrank a
// locale's own, so German must not get these.)
const dropUmlautDots: [string, string][] = [
  ['ä', 'a'], ['Ä', 'A'],
  ['ö', 'o'], ['Ö', 'O'],
  ['ü', 'u'], ['Ü', 'U'],
];

// The browser's language is not always a valid BCP-47 tag (Chromium on a
// Linux with a POSIX locale reports "en-US@posix"), and the library
// lowercases with it — which throws on an invalid tag, and the create-channel
// dialog renders in the sidebar. An invalid tag counts as no locale.
function validLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

// channelName is the name `typed` stands for, transliterated for `locale`
// (a BCP-47 tag, normally the browser's language).
export function channelName(typed: string, locale?: string): string {
  const tag = validLocale(locale);
  return slugify(typed, {
    // What someone types is lowercased letter by letter, so decamelizing
    // would only ever split a pasted "JavaScript" into "java-script".
    decamelize: false,
    locale: tag,
    customReplacements: /^de(-|$)/i.test(tag ?? '') ? [] : dropUmlautDots,
  });
}

// channelNameDraft is channelName for a field that is still being typed in: a
// word-ending character just typed (a space, a dot) stays as a trailing
// hyphen. Without it, "marketing team" could not be typed at all — the space
// would be gone before the "t" arrived.
export function channelNameDraft(typed: string, locale?: string): string {
  const name = channelName(typed, locale);
  return name && /[^\p{L}\p{M}\p{N}]$/u.test(typed) ? `${name}-` : name;
}
