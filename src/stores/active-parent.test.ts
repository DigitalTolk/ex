import { describe, expect, it } from 'vitest';
import { activeParentID, clearActiveParent, isActiveParent, setActiveParent } from './active-parent';

describe('active parent', () => {
  it('records one open parent at a time', () => {
    expect(activeParentID()).toBeNull();
    setActiveParent({ kind: 'channel', id: 'ch-1' });
    expect(activeParentID()).toBe('ch-1');
    expect(isActiveParent('channel', 'ch-1')).toBe(true);
    expect(isActiveParent('conversation', 'ch-1')).toBe(false);
    expect(isActiveParent('channel', 'ch-2')).toBe(false);

    setActiveParent({ kind: 'conversation', id: 'dm-1' });
    expect(isActiveParent('channel', 'ch-1')).toBe(false);
    expect(isActiveParent('conversation', 'dm-1')).toBe(true);
  });

  // Navigating between chats can unmount the old view after the new one
  // registered: the old view's close must not wipe the new parent.
  it('closes a parent only while it is still the open one', () => {
    setActiveParent({ kind: 'conversation', id: 'dm-1' });
    clearActiveParent({ kind: 'channel', id: 'ch-1' });
    clearActiveParent({ kind: 'channel', id: 'dm-1' });
    expect(activeParentID()).toBe('dm-1');
    clearActiveParent({ kind: 'conversation', id: 'dm-1' });
    expect(activeParentID()).toBeNull();
  });

  it('starts every test with no parent open', () => {
    expect(activeParentID()).toBeNull();
  });
});
