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
// Authorization takes what every service that mints one calls an access
// token — "bearer" is how it rides the request, not what the user goes and
// creates.
export function credentialNoun(c: { authHeader?: string }): 'API key' | 'access token' {
  const name = (c.authHeader ?? '').split(':')[0].trim().toLowerCase();
  return name && name !== 'authorization' ? 'API key' : 'access token';
}

function parseURL(raw?: string): URL | null {
  try {
    return new URL(raw ?? '');
  } catch {
    return null;
  }
}

// httpURL keeps only a plain http(s) link. credentialURL is admin-owned and
// the server refuses anything else at ingest, but it is rendered as an href
// the user is invited to click — and rows registered before that check exist.
function httpURL(raw?: string): string {
  const u = parseURL(raw);
  if (!u) return '';
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
}

// tokenHelp is the "where do I get this?" line under the paste field.
//
// The connector says it: credentialHint/credentialURL come with the
// registration, so each service words its own instruction and a new one needs
// no change here. Either half may be missing — a hint with no page to open, or
// a page that needs no explaining.
//
// GitLab falls back to a derived hint because it is the connector people
// actually hit this on, and the fallback works before the registration
// carries one. Nothing else gets a guess: a path we invented sends people
// somewhere that does not exist, which is worse than no hint at all.
export function tokenHelp(c: {
  slug?: string;
  baseURL?: string;
  credentialHint?: string;
  credentialURL?: string;
}): { text: string; url: string } | null {
  const hint = (c.credentialHint ?? '').trim();
  const given = httpURL(c.credentialURL);
  if (hint || given) return { text: hint, url: given };

  const base = parseURL(c.baseURL);
  if (!base) return null;
  const host = base.hostname.toLowerCase();
  if (!(host.includes('gitlab') || (c.slug ?? '').toLowerCase().includes('gitlab'))) return null;
  return {
    text: 'In GitLab: Preferences → Access tokens → Add new token, with the read_api and read_repository scopes.',
    url: `${base.origin}/-/user_settings/personal_access_tokens`,
  };
}
