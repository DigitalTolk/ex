// Pure helpers for the connectors page: an initials mark per connector, a
// stable tint for it, and a tamed rendering of service error text — which can
// be an entire HTML error page when a gateway answers instead of the API.

// connectorInitials picks the letters shown in a connector's mark: the first
// letters of its first two words — camel-case counts as a word break, so
// "GitLab" → GL and "MeetingMind" → MM — or the first two letters of a
// single plain word.
export function connectorInitials(title: string): string {
  const words = title
    .trim()
    .split(/\s+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? '').slice(0, 2).toUpperCase();
}

const TINTS = [
  'text-sky-600 dark:text-sky-400',
  'text-violet-600 dark:text-violet-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-amber-600 dark:text-amber-400',
  'text-rose-600 dark:text-rose-400',
  'text-teal-600 dark:text-teal-400',
] as const;

// connectorTint maps a slug to one of a few text tints for its monogram,
// deterministically, so a connector keeps its colour across renders and
// users. Text-only on purpose: the mark sits on a neutral muted circle.
export function connectorTint(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

export const ERROR_SUMMARY_MAX = 140;

export interface ErrorSummary {
  summary: string;
  // The untouched message, present only when the summary had to shorten or
  // rewrite it — the UI offers it behind a "Details" toggle.
  details?: string;
}

// summarizeError turns a service failure into one readable line. A gateway
// error page collapses to its <title>; other markup is stripped; anything
// long is clipped. The original stays available as details.
export function summarizeError(message: string): ErrorSummary {
  const raw = message.trim();
  let text = raw;
  const title = /<title>([^<]*)<\/title>/i.exec(raw);
  if (title) {
    text = title[1];
  } else if (/<\/?[a-z][^>]*>/i.test(raw)) {
    text = raw.replace(/<[^>]+>/g, ' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) text = 'Request failed';
  if (text.length > ERROR_SUMMARY_MAX) text = text.slice(0, ERROR_SUMMARY_MAX - 1) + '…';
  return text === raw ? { summary: text } : { summary: text, details: raw };
}

// credentialNoun names the credential a connector's paste field wants, from
// its auth header template: anything other than Authorization is an API key.
export function credentialNoun(c: { authHeader?: string }): 'API key' | 'bearer token' {
  const name = (c.authHeader ?? '').split(':')[0].trim().toLowerCase();
  return name && name !== 'authorization' ? 'API key' : 'bearer token';
}
