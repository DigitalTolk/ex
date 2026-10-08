import { create } from 'zustand';
import { readJSON, writeJSON } from '@/lib/storage';

// The last few message searches, newest first, kept on this device so the
// mobile search sheet can offer them again.
const KEY = 'ex:recent-searches';
const MAX = 10;

function load(): string[] {
  const raw = readJSON<unknown>(KEY, []);
  return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === 'string').slice(0, MAX) : [];
}

export const useRecentSearchesStore = create<{ queries: string[] }>(() => ({ queries: load() }));

function save(queries: string[]) {
  useRecentSearchesStore.setState({ queries });
  writeJSON(KEY, queries);
}

export function addRecentSearch(query: string): void {
  const q = query.trim();
  if (!q) return;
  const rest = useRecentSearchesStore.getState().queries.filter((x) => x.toLowerCase() !== q.toLowerCase());
  save([q, ...rest].slice(0, MAX));
}

export function removeRecentSearch(query: string): void {
  save(useRecentSearchesStore.getState().queries.filter((x) => x !== query));
}

export function clearRecentSearches(): void {
  save([]);
}
