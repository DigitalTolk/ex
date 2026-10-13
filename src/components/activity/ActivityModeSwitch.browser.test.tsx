import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityModeSwitch } from './ActivityModeSwitch';
import { apiFetch } from '@/lib/api';
import { resetSidebarModeSessionState } from '@/stores/sidebar-mode';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: vi.fn() }));

describe('ActivityModeSwitch unread badge', () => {
  beforeEach(() => {
    resetSidebarModeSessionState();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({ items: [], unread: 1, unreadByType: {} });
  });
  afterEach(() => {
    cleanup();
  });

  it('hangs off the bell without being clipped by the pill', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/channel/general']}>
          <div style={{ width: 240, padding: 16 }}>
            <ActivityModeSwitch />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const badge = screen.getByTestId('activity-unread-badge');
    await expect.element(badge).toHaveTextContent('1');

    // The badge pokes out past the right edge of the icon-sized Activity pill.
    // Hit-test its far corner: a clipped badge would hand the point to the
    // button (or whatever lies behind it) instead.
    const button = screen.getByTestId('sidebar-mode-activity').element();
    const rect = badge.element().getBoundingClientRect();
    const pill = button.getBoundingClientRect();
    expect(rect.right).toBeGreaterThan(pill.right);
    const hit = document.elementFromPoint(rect.right - 1, rect.top + rect.height / 2);
    expect(badge.element().contains(hit)).toBe(true);
  });
});
