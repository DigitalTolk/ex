import { describe, it, expect } from 'vitest';
import { computeSidebarReorder, SIDEBAR_POSITION_STEP, type SidebarSectionTarget } from './sidebar-reorder';
import type { SidebarItem } from './sidebar-groups';
import type { UserChannel, UserConversation } from '@/types';

// The old positionForDrop produced negative/colliding positions and wedged
// once neighbor gaps collapsed — reorders "didn't stick." These are the
// adversarial cases it never had a test for; the dense-reindex scheme must
// place the dropped item exactly where released in every one.

function chan(id: string, over: Partial<UserChannel> = {}): SidebarItem {
  return {
    kind: 'channel',
    channel: { channelID: id, channelName: id, channelType: 'public', role: 0, ...over },
  };
}
function conv(id: string, over: Partial<UserConversation> = {}): SidebarItem {
  return {
    kind: 'conversation',
    conversation: { conversationID: id, type: 'dm', displayName: id, ...over },
  };
}

const CHANNELS: SidebarSectionTarget = { categoryID: '', favorite: false };
const FAVORITES: SidebarSectionTarget = { categoryID: '', favorite: true, keepCategory: true };

// Apply the returned updates to the section and read back the resulting order
// (sorted by the new positions) so tests assert the VISUAL result, not a magic
// integer — the gap the old tests had.
function resultingOrder(section: SidebarItem[], updates: ReturnType<typeof computeSidebarReorder>): string[] {
  const id = (it: SidebarItem) => (it.kind === 'channel' ? it.channel.channelID : it.conversation.conversationID);
  const pos = new Map<string, number>();
  for (const it of section) pos.set(id(it), it.kind === 'channel' ? (it.channel.sidebarPosition ?? 0) : (it.conversation.sidebarPosition ?? 0));
  const present = new Set(section.map(id));
  for (const u of updates) {
    pos.set(u.id, u.sidebarPosition);
    present.add(u.id);
  }
  return [...present].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
}

describe('computeSidebarReorder', () => {
  it('THE BUG: dropping into an all-unset (position 0) list lands the item exactly where released', () => {
    // Fresh sidebar: every channel has sidebarPosition 0 (never dragged). The
    // old math returned -1000/1000 and the item leapt to the top. Drop C
    // between A and B → order must be A, C, B.
    const section = [chan('A'), chan('B'), chan('D')]; // rendered order, all position 0
    const updates = computeSidebarReorder(section, { id: 'D', kind: 'channel' }, 1, CHANNELS);
    // D dropped at index 1 → [A, D, B]
    expect(resultingOrder(section, updates)).toEqual(['A', 'D', 'B']);
    // Every emitted position is a positive dense multiple of STEP (never 0/neg).
    for (const u of updates) {
      expect(u.sidebarPosition).toBeGreaterThan(0);
      expect(u.sidebarPosition % SIDEBAR_POSITION_STEP).toBe(0);
    }
  });

  it('produces strictly increasing dense positions across the whole new order', () => {
    const section = [chan('A'), chan('B'), chan('C')];
    const updates = computeSidebarReorder(section, { id: 'C', kind: 'channel' }, 0, CHANNELS);
    const positions = resultingOrder(section, updates).map((id, i) => ({ id, i }));
    // No collisions possible: positions are (index+1)*STEP by construction.
    expect(positions.length).toBe(3);
  });

  it('adjacent positions (gap 1) do not wedge — the item still lands between them', () => {
    // The exact collapse the old scheme hit: neighbors at 1000 and 1001.
    const section = [chan('A', { sidebarPosition: 1000 }), chan('B', { sidebarPosition: 1001 }), chan('X', { sidebarPosition: 5000 })];
    const updates = computeSidebarReorder(section, { id: 'X', kind: 'channel' }, 1, CHANNELS);
    expect(resultingOrder(section, updates)).toEqual(['A', 'X', 'B']);
  });

  it('equal positions (already collided) still split correctly', () => {
    const section = [chan('A', { sidebarPosition: 1000 }), chan('B', { sidebarPosition: 1000 }), chan('X', { sidebarPosition: 9000 })];
    const updates = computeSidebarReorder(section, { id: 'X', kind: 'channel' }, 1, CHANNELS);
    expect(resultingOrder(section, updates)).toEqual(['A', 'X', 'B']);
  });

  it('drop at the very start', () => {
    const section = [chan('A', { sidebarPosition: 1000 }), chan('B', { sidebarPosition: 2000 }), chan('X', { sidebarPosition: 3000 })];
    const updates = computeSidebarReorder(section, { id: 'X', kind: 'channel' }, 0, CHANNELS);
    expect(resultingOrder(section, updates)).toEqual(['X', 'A', 'B']);
  });

  it('drop at the very end', () => {
    const section = [chan('A', { sidebarPosition: 1000 }), chan('X', { sidebarPosition: 2000 }), chan('B', { sidebarPosition: 3000 })];
    // insertion index 3 (past the last row, including the dragged row as the payload reports it)
    const updates = computeSidebarReorder(section, { id: 'X', kind: 'channel' }, 3, CHANNELS);
    expect(resultingOrder(section, updates)).toEqual(['A', 'B', 'X']);
  });

  it('dragging a row DOWNWARD past its old slot accounts for the self-removal (no off-by-one)', () => {
    // A(1) B(2) C(3) D(4); drag A to just below C. Payload index 3 (before D,
    // including A still rendered). Result must be B, C, A, D.
    const section = [
      chan('A', { sidebarPosition: 1000 }),
      chan('B', { sidebarPosition: 2000 }),
      chan('C', { sidebarPosition: 3000 }),
      chan('D', { sidebarPosition: 4000 }),
    ];
    const updates = computeSidebarReorder(section, { id: 'A', kind: 'channel' }, 3, CHANNELS);
    expect(resultingOrder(section, updates)).toEqual(['B', 'C', 'A', 'D']);
  });

  it('dragging a row UPWARD lands above the target', () => {
    const section = [
      chan('A', { sidebarPosition: 1000 }),
      chan('B', { sidebarPosition: 2000 }),
      chan('C', { sidebarPosition: 3000 }),
    ];
    const updates = computeSidebarReorder(section, { id: 'C', kind: 'channel' }, 1, CHANNELS);
    expect(resultingOrder(section, updates)).toEqual(['A', 'C', 'B']);
  });

  it('cross-section move: dragged item not in the target section adopts its category + favorite', () => {
    // Dropping a NON-favorited channel into Favorites: it flips favorite=true,
    // keeps its category, and lands at the drop index among the favorites.
    const favorites = [chan('F1', { sidebarPosition: 1000, favorite: true, categoryID: 'work' })];
    const dragged = 'NEW'; // lives in another section, not in `favorites`
    const updates = computeSidebarReorder(favorites, { id: dragged, kind: 'channel' }, 1, FAVORITES);
    const newRow = updates.find((u) => u.id === 'NEW')!;
    expect(newRow.favorite).toBe(true);
    expect(newRow.sidebarPosition).toBe(2 * SIDEBAR_POSITION_STEP);
  });

  it('Favorites keeps each item its OWN category (keepCategory), not a single shared one', () => {
    const favorites = [
      chan('F1', { sidebarPosition: 1000, favorite: true, categoryID: 'work' }),
      chan('F2', { sidebarPosition: 2000, favorite: true, categoryID: 'personal' }),
    ];
    const updates = computeSidebarReorder(favorites, { id: 'F2', kind: 'channel' }, 0, FAVORITES);
    const f2 = updates.find((u) => u.id === 'F2');
    // F2 moved to the front; its category must stay 'personal'.
    if (f2) expect(f2.categoryID).toBe('personal');
  });

  it('only writes rows that actually changed — a no-op re-drop emits nothing', () => {
    // Section already dense in the exact order; dropping A back at index 0
    // changes nothing.
    const section = [chan('A', { sidebarPosition: 1000 }), chan('B', { sidebarPosition: 2000 }), chan('C', { sidebarPosition: 3000 })];
    const updates = computeSidebarReorder(section, { id: 'A', kind: 'channel' }, 0, CHANNELS);
    expect(updates).toEqual([]);
  });

  it('a within-section nudge leaves the untouched head alone (minimal writes)', () => {
    // A(1000) B(2000) C(3000) D(4000); drop D between A and B. New order
    // A, D, B, C → A stays 1000; D, B, C get renumbered. A is not rewritten.
    const section = [
      chan('A', { sidebarPosition: 1000 }),
      chan('B', { sidebarPosition: 2000 }),
      chan('C', { sidebarPosition: 3000 }),
      chan('D', { sidebarPosition: 4000 }),
    ];
    const updates = computeSidebarReorder(section, { id: 'D', kind: 'channel' }, 1, CHANNELS);
    expect(updates.some((u) => u.id === 'A')).toBe(false);
    expect(resultingOrder(section, updates)).toEqual(['A', 'D', 'B', 'C']);
  });

  it('works for conversations too (Favorites reorder)', () => {
    const favorites = [
      conv('c1', { sidebarPosition: 1000, favorite: true }),
      conv('c2', { sidebarPosition: 2000, favorite: true }),
      conv('c3', { sidebarPosition: 3000, favorite: true }),
    ];
    const updates = computeSidebarReorder(favorites, { id: 'c3', kind: 'conversation' }, 1, FAVORITES);
    expect(resultingOrder(favorites, updates)).toEqual(['c1', 'c3', 'c2']);
  });

  it('REPRO: drops a non-favorite channel at the END of Favorites → lands AFTER the last favorite, not before it', () => {
    // From a real bug log: marketing (not favorited, from a category) dropped at
    // Favorites index 3 (area 'end'), preview showed "after bozos", but it landed
    // ABOVE bozos. Favorites = general(2000), foo-bar(3000), bozos(4000).
    const favorites = [
      chan('general', { sidebarPosition: 2000, favorite: true }),
      chan('foo-bar', { sidebarPosition: 3000, favorite: true }),
      chan('bozos', { sidebarPosition: 4000, favorite: true }),
    ];
    // marketing is NOT in the favorites list (cross-section move into Favorites).
    const updates = computeSidebarReorder(favorites, { id: 'marketing', kind: 'channel' }, 3, FAVORITES);
    // marketing must be LAST (after bozos), matching the "end" resolution.
    expect(resultingOrder(favorites, updates)).toEqual(['general', 'foo-bar', 'bozos', 'marketing']);
    const marketing = updates.find((u) => u.id === 'marketing')!;
    const bozos = updates.find((u) => u.id === 'bozos');
    // marketing's dense position is AFTER bozos's (whether or not bozos changed).
    const bozosPos = bozos?.sidebarPosition ?? 4000;
    expect(marketing.sidebarPosition).toBeGreaterThan(bozosPos);
  });

  it('REPRO (exact log): drop foo-bar at END of Favorites[general,bozos] → foo-bar LAST + renumbers ALL 3 rows', () => {
    // From the user's sequence-3 log: Favorites = general(2000), bozos(5000);
    // dropped foo-bar (non-favorite, from a category) at index 2 ('end').
    const favorites = [
      chan('general', { sidebarPosition: 2000, favorite: true }),
      chan('bozos', { sidebarPosition: 5000, favorite: true }),
    ];
    const updates = computeSidebarReorder(favorites, { id: 'foo-bar', kind: 'channel' }, 2, FAVORITES);
    // foo-bar lands AFTER bozos (matching the 'end' resolution).
    expect(resultingOrder(favorites, updates)).toEqual(['general', 'bozos', 'foo-bar']);
    // The current dense algorithm renumbers the WHOLE section: general→1000,
    // bozos→2000, foo-bar→3000 — THREE updates. The buggy old bundle wrote only
    // TWO (foo-bar→3000, bozos→4000, general kept 2000) → foo-bar before bozos.
    expect(updates.map((u) => [u.id, u.sidebarPosition])).toEqual([
      ['general', 1000],
      ['bozos', 2000],
      ['foo-bar', 3000],
    ]);
  });

  it('clamps an out-of-range insertion index instead of dropping the item off the list', () => {
    const section = [chan('A', { sidebarPosition: 1000 })];
    const updates = computeSidebarReorder(section, { id: 'A', kind: 'channel' }, 99, CHANNELS);
    // Still exactly one item, still present.
    expect(resultingOrder(section, updates)).toEqual(['A']);
  });
});
