import type { ReactNode } from 'react';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';

// The syntax highlighter (lowlight + its grammars, ~37 KB gzip) loads with
// the first code block that names a supported language, instead of shipping
// in the boot bundle with the message renderer. Until it arrives the block
// shows its code as plain text in the same box (see CodeBlock).

type Highlighter = typeof import('@/lib/code-highlight');

const importHighlighter = (): Promise<Highlighter> => import('@/lib/code-highlight');

// Test seam: a test holds the import open to look at a block before the
// highlighting arrives.
export const highlighterImport = { load: importHighlighter };

let highlighter: Highlighter | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function subscribeHighlighter(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getHighlighter(): Highlighter | null {
  return highlighter;
}

// A failed load (a stale deploy's missing chunk) leaves the blocks plain and
// lets the next block try again.
export function loadHighlighter(): void {
  if (highlighter || loading) return;
  loading = highlighterImport.load().then(
    (mod) => {
      highlighter = mod;
      for (const listener of listeners) listener();
    },
    () => {
      loading = null;
    },
  );
}

// Highlighted output per (language, code), so a row the virtualized list
// unmounts and mounts again — every scroll past it — does not run the
// grammar again. Bounded: the least recently shown block goes first.
const MAX_CACHED_BLOCKS = 200;
const cache = new Map<string, ReactNode>();

export function highlightedCode(mod: Highlighter, code: string, language: string): ReactNode {
  const key = `${language}\u0000${code}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const tree = mod.highlightToHast(code, language);
  const node: ReactNode = tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : null;
  cache.set(key, node);
  if (cache.size > MAX_CACHED_BLOCKS) cache.delete(cache.keys().next().value as string);
  return node;
}

export function resetCodeHighlightForTests() {
  highlighter = null;
  loading = null;
  cache.clear();
  highlighterImport.load = importHighlighter;
}
