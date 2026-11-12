import { create } from 'zustand';
import { readJSON, removeKey, writeJSON } from '@/lib/storage';

// The last few message searches, and the channels, people and group messages
// opened from search, newest first, kept on this device per user so the mobile
// search sheet can offer them again. What someone searched for never outlives
// their session: logout wipes it, and another account on the same device reads
// only its own lists.
const KEY_PREFIX = 'ex:recent-searches';
const MAX = 10;

function keyFor(userID: string): string {
  return `${KEY_PREFIX}:${userID}`;
}

function openedKeyFor(userID: string): string {
  return `${KEY_PREFIX}:opened:${userID}`;
}

// A channel, person or group message opened from search. `id` is the
// channel, user or conversation ID; a channel also keeps the slug its route
// uses.
export type RecentOpened =
  | { kind: 'channel'; id: string; slug: string; name: string; private: boolean }
  | { kind: 'user'; id: string; name: string }
  | { kind: 'group'; id: string; name: string };

function load(userID: string): string[] {
  const raw = readJSON<unknown>(keyFor(userID), []);
  return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === 'string').slice(0, MAX) : [];
}

function isOpened(v: unknown): v is RecentOpened {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false;
  if (o.kind === 'channel') return typeof o.slug === 'string' && typeof o.private === 'boolean';
  return o.kind === 'user' || o.kind === 'group';
}

function loadOpened(userID: string): RecentOpened[] {
  const raw = readJSON<unknown>(openedKeyFor(userID), []);
  return Array.isArray(raw) ? raw.filter(isOpened).slice(0, MAX) : [];
}

interface RecentSearchesState {
  userID: string | null;
  queries: string[];
  opened: RecentOpened[];
}

export const useRecentSearchesStore = create<RecentSearchesState>(() => ({ userID: null, queries: [], opened: [] }));

// loadRecentSearches points the store at a user's lists (read once per user).
export function loadRecentSearches(userID: string): void {
  if (useRecentSearchesStore.getState().userID === userID) return;
  useRecentSearchesStore.setState({ userID, queries: load(userID), opened: loadOpened(userID) });
}

function save(queries: string[]) {
  const { userID } = useRecentSearchesStore.getState();
  if (!userID) return;
  useRecentSearchesStore.setState({ queries });
  writeJSON(keyFor(userID), queries);
}

function saveOpened(opened: RecentOpened[]) {
  const { userID } = useRecentSearchesStore.getState();
  if (!userID) return;
  useRecentSearchesStore.setState({ opened });
  writeJSON(openedKeyFor(userID), opened);
}

const sameOpened = (a: RecentOpened, b: RecentOpened) => a.kind === b.kind && a.id === b.id;

// addRecentOpened moves a channel, person or group to the top of the list.
export function addRecentOpened(entry: RecentOpened): void {
  const rest = useRecentSearchesStore.getState().opened.filter((x) => !sameOpened(x, entry));
  saveOpened([entry, ...rest].slice(0, MAX));
}

export function removeRecentOpened(entry: RecentOpened): void {
  saveOpened(useRecentSearchesStore.getState().opened.filter((x) => !sameOpened(x, entry)));
}

export function clearRecentOpened(): void {
  saveOpened([]);
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

// resetRecentSearchesSessionState forgets every stored list, the searches and
// the opened list alike (both keys share the prefix), on logout and when the
// session ends, so nobody signing in next on this device sees what was
// searched before.
export function resetRecentSearchesSessionState(): void {
  useRecentSearchesStore.setState({ userID: null, queries: [], opened: [] });
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) removeKey(key);
    }
  } catch {
    // Storage blocked (private mode): nothing was persisted.
  }
}
