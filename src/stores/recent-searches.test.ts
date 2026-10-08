import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ex:recent-searches';

async function freshStore() {
  vi.resetModules();
  return import('./recent-searches');
}

describe('recent searches', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty and keeps the newest first, case-insensitively unique, capped at ten', async () => {
    const m = await freshStore();
    expect(m.useRecentSearchesStore.getState().queries).toEqual([]);
    m.addRecentSearch('  release  ');
    m.addRecentSearch('standup');
    m.addRecentSearch('Release');
    expect(m.useRecentSearchesStore.getState().queries).toEqual(['Release', 'standup']);
    for (let i = 0; i < 12; i++) m.addRecentSearch(`q${i}`);
    expect(m.useRecentSearchesStore.getState().queries).toHaveLength(10);
    expect(m.useRecentSearchesStore.getState().queries[0]).toBe('q11');
    expect(JSON.parse(localStorage.getItem(KEY)!)[0]).toBe('q11');
  });

  it('ignores blank queries', async () => {
    const m = await freshStore();
    m.addRecentSearch('   ');
    expect(m.useRecentSearchesStore.getState().queries).toEqual([]);
  });

  it('removes one and clears all', async () => {
    const m = await freshStore();
    m.addRecentSearch('a');
    m.addRecentSearch('b');
    m.removeRecentSearch('a');
    expect(m.useRecentSearchesStore.getState().queries).toEqual(['b']);
    m.clearRecentSearches();
    expect(m.useRecentSearchesStore.getState().queries).toEqual([]);
    expect(localStorage.getItem(KEY)).toBe('[]');
  });

  it('loads what was saved, dropping anything that is not a string', async () => {
    localStorage.setItem(KEY, JSON.stringify(['one', 2, 'two']));
    const m = await freshStore();
    expect(m.useRecentSearchesStore.getState().queries).toEqual(['one', 'two']);
  });

  it('treats a saved value that is not a list as empty', async () => {
    localStorage.setItem(KEY, JSON.stringify({ nope: true }));
    const m = await freshStore();
    expect(m.useRecentSearchesStore.getState().queries).toEqual([]);
  });
});
