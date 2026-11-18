import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// How the sidebar is coloured is a preference of the device: it outlives a
// reload. Each load() is a fresh page reading what the last one stored.

async function load() {
  vi.resetModules();
  return import('./sidebar-theme');
}

beforeEach(() => {
  localStorage.clear();
});

describe('sidebar theme store', () => {
  it('starts dark, which scopes the dark palette to the sidebar', async () => {
    const store = await load();
    expect(store.useSidebarThemeStore.getState().theme).toBe('dark');
    const { result } = renderHook(() => store.useSidebarThemeClass());
    expect(result.current).toBe('dark');
  });

  it('leaves the sidebar to the app theme once set to light, and back', async () => {
    const store = await load();
    const { result } = renderHook(() => store.useSidebarThemeClass());
    act(() => store.setSidebarTheme('light'));
    expect(result.current).toBe('');
    act(() => store.setSidebarTheme('dark'));
    expect(result.current).toBe('dark');
  });

  it('remembers the choice on this device after a reload', async () => {
    const before = await load();
    before.setSidebarTheme('light');
    expect(localStorage.getItem(before.SIDEBAR_THEME_STORAGE_KEY)).toContain('"theme":"light"');

    const after = await load();
    expect(after.useSidebarThemeStore.getState().theme).toBe('light');

    after.setSidebarTheme('dark');
    const again = await load();
    expect(again.useSidebarThemeStore.getState().theme).toBe('dark');
  });

  it('forgets the choice when its storage is cleared', async () => {
    const before = await load();
    before.setSidebarTheme('light');
    before.useSidebarThemeStore.persist.clearStorage();
    expect(localStorage.getItem(before.SIDEBAR_THEME_STORAGE_KEY)).toBeNull();
    const after = await load();
    expect(after.useSidebarThemeStore.getState().theme).toBe('dark');
  });

  it('works without storage (private mode)', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      const store = await load();
      store.setSidebarTheme('light');
      expect(store.useSidebarThemeStore.getState().theme).toBe('light');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
