import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ActivityPage from './ActivityPage';
import { apiFetch } from '@/lib/api';

// The real virtualized list in a real layout: the list scrolls with the page's
// scroll container (it owns no scroller), renders only the rows near the
// viewport, and brings later rows in as the page scrolls. jsdom has no layout,
// so activity-page.test.tsx stubs the list; this proves the real one.

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-me' } }) }));

const ROWS = 300;

function mention(n: number) {
  return {
    id: `01J${String(n).padStart(23, '0')}`,
    type: 'mention',
    mentionKind: 'user',
    createdAt: '2026-10-08T10:00:00Z',
    messageID: `m-${n}`,
    parentID: 'ch-1',
    parentType: 'channel',
    channelSlug: 'general',
    messagePreview: `message number ${n}`,
    actorID: 'u-2',
    read: n !== 0,
  };
}

const mounted: Array<{ unmount: () => Promise<void> }> = [];

async function mountPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = await render(
    // A fixed-height app shell, like the real layout: the page container is
    // the scroller.
    <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/activity']}>
          <ActivityPage />
        </MemoryRouter>
      </QueryClientProvider>
    </div>,
  );
  mounted.push(result);
  return result;
}

describe('ActivityPage browser', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/api/v1/activity') return { items: Array.from({ length: ROWS }, (_, i) => mention(i)), unread: 1, unreadByType: { mention: 1 } };
      if (path === '/api/v1/users/batch') return [{ id: 'u-2', displayName: 'Bob' }];
      if (path === '/api/v1/reminders' || path === '/api/v1/channels') return [];
      return undefined;
    });
  });
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.unmount();
    vi.mocked(apiFetch).mockReset();
  });

  it('renders only the rows near the viewport and follows the page scroll', async () => {
    const screen = await mountPage();
    await expect.element(screen.getByText('message number 0')).toBeVisible();
    const rendered = document.querySelectorAll('[data-testid="activity-item"]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(ROWS);

    // The list re-measures as rows mount, so one jump to the bottom can land
    // short of it; keep scrolling until the last row is in.
    const scroller = document.querySelector<HTMLElement>('[data-page-scroll]')!;
    await vi.waitFor(
      () => {
        scroller.scrollTop = scroller.scrollHeight;
        expect(document.body.textContent).toContain(`message number ${ROWS - 1}`);
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(document.querySelector('[data-testid="activity-item"]')?.textContent).not.toContain('message number 0');
  });

  it('marks a row read from its menu', async () => {
    const screen = await mountPage();
    await expect.element(screen.getByText('message number 0')).toBeVisible();
    await userEvent.click(screen.getByTestId('activity-actions').first());
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mark as read' }));
    await vi.waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/activity/items/read', {
        method: 'PUT',
        body: JSON.stringify({ ids: [mention(0).id], read: true }),
      }),
    );
  });
});
