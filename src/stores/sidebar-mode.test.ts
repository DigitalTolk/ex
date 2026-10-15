import { beforeEach, describe, expect, it, vi } from 'vitest';

// "Unread only" on the Activity list is a preference of the device: it
// outlives a reload and a sign-out. The rest of the sidebar's state is the
// session's.

async function load() {
  vi.resetModules();
  return import('./sidebar-mode');
}

beforeEach(() => {
  localStorage.clear();
});

describe('sidebar mode store', () => {
  it('starts on the channel list, everything off', async () => {
    const { useSidebarModeStore } = await load();
    expect(useSidebarModeStore.getState()).toMatchObject({
      mode: 'home',
      filter: 'all',
      unreadOnly: false,
      selectedKey: null,
    });
  });

  it('remembers "Unread only" on this device after a reload — and only that', async () => {
    const before = await load();
    before.setActivityUnreadOnly(true);
    before.setSidebarMode('activity');
    before.setActivityFilter('mention');
    before.selectActivityRow('row-1');

    const after = await load();
    expect(after.useSidebarModeStore.getState()).toMatchObject({
      mode: 'home',
      filter: 'all',
      unreadOnly: true,
      selectedKey: null,
    });

    after.setActivityUnreadOnly(false);
    const again = await load();
    expect(again.useSidebarModeStore.getState().unreadOnly).toBe(false);
  });

  it('keeps "Unread only" through a sign-out, which resets the rest', async () => {
    const store = await load();
    store.setActivityUnreadOnly(true);
    store.setSidebarMode('activity');
    store.setActivityFilter('dm');
    store.selectActivityRow('row-1');

    store.resetSidebarModeSessionState();

    expect(store.useSidebarModeStore.getState()).toMatchObject({
      mode: 'home',
      filter: 'all',
      unreadOnly: true,
      selectedKey: null,
    });
    const reloaded = await load();
    expect(reloaded.useSidebarModeStore.getState().unreadOnly).toBe(true);
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
      store.setActivityUnreadOnly(true);
      expect(store.useSidebarModeStore.getState().unreadOnly).toBe(true);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
