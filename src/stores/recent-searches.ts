import { create } from 'zustand';
import { readJSON, removeKey, writeJSON } from '@/lib/storage';

// The last few message searches, newest first, kept on this device per user so
// the mobile search sheet can offer them again. Free text someone typed, so it
// never outlives their session: logout wipes it, and another account on the
// same device reads only its own list.
const KEY_PREFIX = 'ex:recent-searches';
const MAX = 10;

function keyFor(userID: string): string {
  return `${KEY_PREFIX}:${userID}`;
}

function load(userID: string): string[] {
  const raw = readJSON<unknown>(keyFor(userID), []);
  return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === 'string').slice(0, MAX) : [];
}

interface RecentSearchesState {
  userID: string | null;
  queries: string[];
}

export const useRecentSearchesStore = create<RecentSearchesState>(() => ({ userID: null, queries: [] }));

// loadRecentSearches points the store at a user's list (read once per user).
export function loadRecentSearches(userID: string): void {
  if (useRecentSearchesStore.getState().userID === userID) return;
  useRecentSearchesStore.setState({ userID, queries: load(userID) });
}

function save(queries: string[]) {
  const { userID } = useRecentSearchesStore.getState();
  if (!userID) return;
  useRecentSearchesStore.setState({ queries });
  writeJSON(keyFor(userID), queries);
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

// resetRecentSearchesSessionState forgets every stored list — on logout and
// when the session ends — so nobody signing in next on this device sees what
// was searched before.
export function resetRecentSearchesSessionState(): void {
  useRecentSearchesStore.setState({ userID: null, queries: [] });
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) removeKey(key);
    }
  } catch {
    // Storage blocked (private mode): nothing was persisted.
  }
}
