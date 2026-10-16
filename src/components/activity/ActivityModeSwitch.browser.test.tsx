import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActivityModeSwitch } from './ActivityModeSwitch';
import { apiFetch } from '@/lib/api';
import { resetSidebarModeSessionState } from '@/stores/sidebar-mode';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: vi.fn() }));

describe('ActivityModeSwitch unread dot', () => {
  beforeEach(() => {
    resetSidebarModeSessionState();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({ items: [], unread: 1, unreadByType: {} });
  });
  afterEach(() => {
    cleanup();
  });

  it('sits on the bell, inside the pill and unclipped, with no count', async () => {
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
    const dot = screen.getByTestId('activity-unread-dot');
    await expect.element(dot).toBeVisible();
    expect(dot.element()).toBeEmptyDOMElement();

    // The dot sits on the bell, inside the icon-sized Activity pill. Hit-test
    // its centre: a clipped dot would hand the point to the button instead.
    const button = screen.getByTestId('sidebar-mode-activity').element();
    const rect = dot.element().getBoundingClientRect();
    const pill = button.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(pill.right);
    expect(rect.top).toBeGreaterThanOrEqual(pill.top);
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(dot.element().contains(hit)).toBe(true);
  });
});
