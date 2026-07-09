import type { ReactNode } from 'react';

// highlight wraps every case-insensitive occurrence of `q` inside
// `body` with a <mark> element so search hits visibly indicate the
// matched substring.
export function highlight(body: string, q: string): ReactNode {
  const trimmed = q.trim();
  if (!trimmed) return body;
  const parts = body.split(new RegExp(`(${escapeRegExp(trimmed)})`, 'ig'));
  return parts.map((part, i) =>
    part.toLowerCase() === trimmed.toLowerCase() ? (
      <mark
        key={i}
        className="bg-amber-200/60 text-amber-950 dark:bg-amber-500/30 dark:text-amber-100"
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
