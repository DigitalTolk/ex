import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecentOpened,
  addRecentSearch,
  clearRecentOpened,
  clearRecentSearches,
  removeRecentOpened,
  loadRecentSearches,
  removeRecentSearch,
  resetRecentSearchesSessionState,
  useRecentSearchesStore,
} from './recent-searches';

const keyFor = (userID: string) => `ex:recent-searches:${userID}`;
const queries = () => useRecentSearchesStore.getState().queries;
const opened = () => useRecentSearchesStore.getState().opened;
const openedKeyFor = (userID: string) => `ex:recent-searches:opened:${userID}`;
const general = { kind: 'channel', id: 'ch-1', slug: 'general', name: 'general', private: false } as const;
const alice = { kind: 'user', id: 'u-alice', name: 'Alice' } as const;
const team = { kind: 'group', id: 'conv-1', name: 'Alice, Bob' } as const;

describe('recent searches', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRecentSearchesSessionState();
  });

  it('keeps the newest first, case-insensitively unique, capped at ten, per user', () => {
    loadRecentSearches('u-1');
    expect(queries()).toEqual([]);
    addRecentSearch('  release  ');
    addRecentSearch('standup');
    addRecentSearch('Release');
    expect(queries()).toEqual(['Release', 'standup']);
    for (let i = 0; i < 12; i++) addRecentSearch(`q${i}`);
    expect(queries()).toHaveLength(10);
    expect(queries()[0]).toBe('q11');
    expect(JSON.parse(localStorage.getItem(keyFor('u-1'))!)[0]).toBe('q11');
  });

  it('ignores blank queries, and records nothing before a user is known', () => {
    addRecentSearch('before sign-in');
    expect(queries()).toEqual([]);
    loadRecentSearches('u-1');
    addRecentSearch('   ');
    expect(queries()).toEqual([]);
  });

  it('removes one and clears all', () => {
    loadRecentSearches('u-1');
    addRecentSearch('a');
    addRecentSearch('b');
    removeRecentSearch('a');
    expect(queries()).toEqual(['b']);
    clearRecentSearches();
    expect(queries()).toEqual([]);
    expect(localStorage.getItem(keyFor('u-1'))).toBe('[]');
  });

  it('loads what was saved, dropping anything that is not a string, once per user', () => {
    localStorage.setItem(keyFor('u-1'), JSON.stringify(['one', 2, 'two']));
    loadRecentSearches('u-1');
    expect(queries()).toEqual(['one', 'two']);
    // Loading the same user again keeps what's in memory.
    localStorage.setItem(keyFor('u-1'), JSON.stringify(['changed']));
    loadRecentSearches('u-1');
    expect(queries()).toEqual(['one', 'two']);
  });

  it('treats a saved value that is not a list as empty', () => {
    localStorage.setItem(keyFor('u-1'), JSON.stringify({ nope: true }));
    loadRecentSearches('u-1');
    expect(queries()).toEqual([]);
  });

  // Free text one person typed must never show to the next one on the device.
  it("never shows one user's searches to another", () => {
    loadRecentSearches('u-alice');
    addRecentSearch('salary review');
    loadRecentSearches('u-bob');
    expect(queries()).toEqual([]);
    addRecentSearch('standup');
    loadRecentSearches('u-alice');
    expect(queries()).toEqual(['salary review']);
  });

  it('forgets every stored list when the session ends', () => {
    localStorage.setItem('ex:recent-searches', JSON.stringify(['from an older build']));
    localStorage.setItem('ex:other', 'kept');
    loadRecentSearches('u-1');
    addRecentSearch('layoffs');
    resetRecentSearchesSessionState();
    expect(useRecentSearchesStore.getState()).toEqual({ userID: null, queries: [], opened: [] });
    expect(localStorage.getItem(keyFor('u-1'))).toBeNull();
    expect(localStorage.getItem('ex:recent-searches')).toBeNull();
    expect(localStorage.getItem('ex:other')).toBe('kept');
    loadRecentSearches('u-1');
    expect(queries()).toEqual([]);
  });

  it('still resets the store when storage is blocked', () => {
    loadRecentSearches('u-1');
    const spy = vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    resetRecentSearchesSessionState();
    spy.mockRestore();
    expect(useRecentSearchesStore.getState()).toEqual({ userID: null, queries: [], opened: [] });
  });

  it('keeps what was opened from search newest first, unique per kind and ID, capped at ten', () => {
    addRecentOpened(general);
    expect(opened()).toEqual([]);
    loadRecentSearches('u-1');
    addRecentOpened(general);
    addRecentOpened(alice);
    addRecentOpened({ ...general, name: 'general-renamed' });
    addRecentOpened(team);
    expect(opened()).toEqual([team, { ...general, name: 'general-renamed' }, alice]);
    // A user and a group with the same ID are different entries.
    addRecentOpened({ kind: 'group', id: 'u-alice', name: 'x' });
    expect(opened()).toHaveLength(4);
    for (let i = 0; i < 12; i++) addRecentOpened({ kind: 'user', id: `u${i}`, name: `U${i}` });
    expect(opened()).toHaveLength(10);
    expect(JSON.parse(localStorage.getItem(openedKeyFor('u-1'))!)[0]).toEqual({ kind: 'user', id: 'u11', name: 'U11' });
  });

  it('removes one opened entry and clears them all', () => {
    loadRecentSearches('u-1');
    addRecentOpened(general);
    addRecentOpened(alice);
    removeRecentOpened(general);
    expect(opened()).toEqual([alice]);
    clearRecentOpened();
    expect(opened()).toEqual([]);
    expect(localStorage.getItem(openedKeyFor('u-1'))).toBe('[]');
  });

  it('loads the opened list, dropping malformed entries', () => {
    localStorage.setItem(
      openedKeyFor('u-1'),
      JSON.stringify([
        general,
        alice,
        team,
        null,
        'general',
        { kind: 'channel', id: 'ch-2', name: 'no-slug', private: false },
        { kind: 'channel', id: 'ch-3', slug: 'x', name: 'x' },
        { kind: 'user', id: 7, name: 'bad id' },
        { kind: 'user', id: 'u-2' },
        { kind: 'robot', id: 'r', name: 'r' },
      ]),
    );
    loadRecentSearches('u-1');
    expect(opened()).toEqual([general, alice, team]);
  });

  it('treats a saved opened value that is not a list as empty, and forgets it at session end', () => {
    localStorage.setItem(openedKeyFor('u-1'), JSON.stringify({ nope: true }));
    loadRecentSearches('u-1');
    expect(opened()).toEqual([]);
    addRecentOpened(general);
    resetRecentSearchesSessionState();
    expect(localStorage.getItem(openedKeyFor('u-1'))).toBeNull();
  });
});
