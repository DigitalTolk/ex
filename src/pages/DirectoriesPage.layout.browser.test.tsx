import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DirectoriesPage from './DirectoriesPage';

// The members grid in a real layout: every card's actions sit on one line
// across a row, however much each card has to show (a deactivated account
// shows almost nothing), and the columns fill the grid's whole width.

const full = (i: number) => ({
  id: `u-${i}`,
  displayName: `Person ${i}`,
  email: `p${i}@example.com`,
  systemRole: 'member',
  status: 'active',
  phone: '+46 70 000 00 00',
  manager: { displayName: 'Boss Person' },
  timeZone: 'Europe/Stockholm',
  lastSeenAt: '2026-10-27T10:00:00Z',
});
const bare = (i: number) => ({ id: `u-${i}`, displayName: `Gone ${i}`, email: `g${i}@example.com`, systemRole: 'member', status: 'deactivated' });

vi.mock('@/lib/api', () => ({
  apiFetch: (url: string) =>
    Promise.resolve(url === '/api/v1/users' ? [...Array.from({ length: 11 }, (_, i) => full(i)), bare(11)] : []),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'me', systemRole: 'member', status: 'active' } }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false }),
}));

async function renderMembers() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/directory/users']}>
        <Routes>
          <Route path="/directory/:section" element={<DirectoriesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect.poll(() => document.querySelectorAll('[data-testid="directory-user-card"]').length).toBe(12);
}

const rect = (el: Element) => el.getBoundingClientRect();

describe('members directory layout', () => {
  it('lines the card actions up across each row of cards', async () => {
    await renderMembers();
    const cards = [...document.querySelectorAll('[data-testid="directory-user-card"]')];
    const rows = new Map<number, number[]>();
    for (const card of cards) {
      const top = Math.round(rect(card).top);
      const actions = card.querySelector('[data-testid="directory-card-actions"]')!;
      rows.set(top, [...(rows.get(top) ?? []), Math.round(rect(actions).bottom)]);
    }
    // The deactivated account (last) shares a row with fuller cards.
    const lastRowTop = Math.round(rect(cards.at(-1)!).top);
    expect(rows.get(lastRowTop)!.length).toBeGreaterThan(1);
    for (const bottoms of rows.values()) {
      expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
    }
  });

  it('fills the grid width with its columns', async () => {
    await renderMembers();
    const grid = rect(document.querySelector('[data-testid="members-grid"]')!);
    const firstRowTop = Math.round(rect(document.querySelector('[data-testid="directory-user-card"]')!).top);
    const firstRow = [...document.querySelectorAll('[data-testid="directory-user-card"]')].filter(
      (card) => Math.round(rect(card).top) === firstRowTop,
    );
    expect(Math.abs(rect(firstRow[0]!).left - grid.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect(firstRow.at(-1)!).right - grid.right)).toBeLessThanOrEqual(1);
  });
});
