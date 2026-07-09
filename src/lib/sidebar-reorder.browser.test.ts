import { describe, it, expect } from 'vitest';
import { computeSidebarReorder, SIDEBAR_POSITION_STEP } from './sidebar-reorder';
import type { SidebarItem } from './sidebar-groups';
import type { UserChannel } from '@/types';

// Browser twin of sidebar-reorder.test.ts. The exhaustive matrix lives in the
// jsdom file; this covers the keepCategory (Favorites) branch in the browser
// project so both coverage gates exercise the reorder math.
function chan(id: string, over: Partial<UserChannel> = {}): SidebarItem {
  return {
    kind: 'channel',
    channel: { channelID: id, channelName: id, channelType: 'public', role: 0, ...over },
  };
}

describe('computeSidebarReorder (browser) — Favorites keepCategory', () => {
  it('the dragged row keeps its OWN category when moved within Favorites; an uncategorized neighbor falls back to ""', () => {
    const favorites = [
      chan('F1', { sidebarPosition: 1000, favorite: true, categoryID: 'work' }),
      // F2 is favorited with NO category — a shifted (non-dragged) row must fall
      // back to '' via `current?.categoryID ?? ''`.
      chan('F2', { sidebarPosition: 2000, favorite: true }),
      chan('F3', { sidebarPosition: 3000, favorite: true, categoryID: 'errands' }),
    ];
    // Move F3 to the front; every row keeps its own category, favorite stays true.
    const updates = computeSidebarReorder(favorites, { id: 'F3', kind: 'channel' }, 0, {
      categoryID: '',
      favorite: true,
      keepCategory: true,
    });
    const f3 = updates.find((u) => u.id === 'F3');
    expect(f3?.categoryID).toBe('errands');
    expect(f3?.favorite).toBe(true);
    expect(f3?.sidebarPosition).toBe(SIDEBAR_POSITION_STEP);
    // The shifted uncategorized neighbor resolves to '' (not undefined).
    const f2 = updates.find((u) => u.id === 'F2');
    expect(f2?.categoryID).toBe('');
    // A shifted categorized neighbor keeps its own category.
    const f1 = updates.find((u) => u.id === 'F1');
    if (f1) expect(f1.categoryID).toBe('work');
  });

  it('a channel entering Favorites from another section keeps its prior category', () => {
    const favorites = [chan('F1', { sidebarPosition: 1000, favorite: true, categoryID: 'work' })];
    // NEW is not in the favorites list (cross-section move); with no current
    // row its category falls back to '' via the nullish chain.
    const updates = computeSidebarReorder(favorites, { id: 'NEW', kind: 'channel' }, 1, {
      categoryID: '',
      favorite: true,
      keepCategory: true,
    });
    const moved = updates.find((u) => u.id === 'NEW');
    expect(moved?.favorite).toBe(true);
    expect(moved?.categoryID).toBe('');
    expect(moved?.sidebarPosition).toBeGreaterThan(0);
  });

  it('a non-keepCategory section (regular channels/DMs) adopts the target category for every row', () => {
    // keepCategory=false is the else-arm: rows take the section's category, not
    // their own. The Sidebar browser tests mock the reorder hook, so this is the
    // only browser exercise of the keepCategory=false path.
    const section = [
      chan('A', { sidebarPosition: 1000, categoryID: 'old' }),
      chan('B', { sidebarPosition: 2000, categoryID: 'old' }),
    ];
    const updates = computeSidebarReorder(section, { id: 'B', kind: 'channel' }, 0, {
      categoryID: 'projects',
      favorite: false,
    });
    const moved = updates.find((u) => u.id === 'B');
    expect(moved?.categoryID).toBe('projects');
    expect(moved?.favorite).toBe(false);
    expect(moved?.sidebarPosition).toBe(SIDEBAR_POSITION_STEP);
  });
});
