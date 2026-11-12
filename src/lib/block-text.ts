import type { Message } from '@/types';

// hasBlocks: whether a message draws any blocks, its own or its cards'. Only
// those messages mount a block scope, so the rest pay nothing per row.
export function hasBlocks(message: Pick<Message, 'blocks' | 'messageAttachments'>): boolean {
  return !!message.blocks?.length || !!message.messageAttachments?.some((a) => a.blocks?.length);
}

// Date tokens in an app's block text: <!date^UNIX^FORMAT|FALLBACK> shows a
// moment in each viewer's own time zone and locale, so "Reviewed at 14:52"
// reads 14:52 in London and 20:22 in Delhi. FORMAT may hold {time},
// {date_short}, {date} and {date_long} (Slack's names); a token this client
// can't read shows its FALLBACK, and one without a fallback stays as written.
const DATE_TOKEN = /<!date\^(\d{1,12})\^([^|>]{1,100})(?:\|([^>]{0,200}))?>/g;

const formats = {
  time: { hour: 'numeric', minute: '2-digit' },
  date_short: { month: 'short', day: 'numeric' },
  date: { month: 'long', day: 'numeric', year: 'numeric' },
  date_long: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

// One formatter per kind, built on first use: constructing Intl formatters is
// what costs, and a card can carry many tokens.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatPart(kind: keyof typeof formats, at: Date): string {
  let formatter = formatters.get(kind);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, formats[kind]);
    formatters.set(kind, formatter);
  }
  return formatter.format(at);
}

export function expandDateTokens(text: string): string {
  if (!text.includes('<!date^')) return text;
  return text.replace(DATE_TOKEN, (token, seconds: string, format: string, fallback?: string) =>
    formatDate(Number(seconds), format) ?? fallback ?? token,
  );
}

// formatDate draws a moment through a format of {time}, {date_short}, {date}
// and {date_long}, in the reader's time zone; undefined when the format holds
// a part this client can't draw (the caller then shows its fallback).
export function formatDate(seconds: number, format: string): string | undefined {
  const at = new Date(seconds * 1000);
  let readable = true;
  const out = format.replace(/\{([a-z_]+)\}/g, (_part, kind: string) => {
    if (kind in formats) return formatPart(kind as keyof typeof formats, at);
    readable = false;
    return '';
  });
  return readable ? out : undefined;
}

// formatTallyTime is when a built-in action happened, short: the time alone
// today, with the date before that.
export function formatTallyTime(at: string, now: Date = new Date()): string {
  const when = new Date(at);
  const time = formatPart('time', when);
  return when.toDateString() === now.toDateString() ? time : `${formatPart('date_short', when)}, ${time}`;
}
