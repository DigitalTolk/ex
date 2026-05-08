import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { AppLayout } from './AppLayout';
import { ResourceErrorPage } from '@/pages/ResourceErrorPage';
import { BUILD_VERSION, resetServerVersionForTests, setServerVersion } from '@/hooks/useServerVersion';
import { apiFetch } from '@/lib/api';

vi.mock('@/components/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => null,
}));

vi.mock('./Sidebar', () => ({
  Sidebar: () => <div>Sidebar</div>,
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('AppLayout reload banner browser behavior', () => {
  it('shows the reload banner above a mobile channel-unavailable error', async () => {
    resetServerVersionForTests();
    setServerVersion(`newer-than-${BUILD_VERSION}`);

    const screen = await renderWithProviders(
      <MemoryRouter initialEntries={['/channel/general']}>
        <div style={{ height: 640 }}>
          <AppLayout>
            <ResourceErrorPage resource="channel" status={500} />
          </AppLayout>
        </div>
      </MemoryRouter>,
    );

    await expect.element(screen.getByText('Channel unavailable')).toBeVisible();
    const reload = screen.getByTestId('update-banner-reload');
    await expect.element(reload).toBeVisible();

    const appHeader = document.querySelector('[data-testid="app-shell-header"]') as HTMLElement | null;
    const banner = document.querySelector('[data-testid="update-banner"]') as HTMLElement | null;
    const error = document.querySelector('[data-testid="resource-error-500"]') as HTMLElement | null;

    expect(appHeader).not.toBeNull();
    expect(banner).not.toBeNull();
    expect(error).not.toBeNull();

    const bannerRect = banner!.getBoundingClientRect();
    const headerRect = appHeader!.getBoundingClientRect();
    const errorRect = error!.getBoundingClientRect();
    expect(bannerRect.top).toBeGreaterThanOrEqual(Math.floor(headerRect.bottom));
    expect(errorRect.top).toBeGreaterThanOrEqual(Math.floor(bannerRect.bottom));
  });

  it('shows the reload banner when a failing channel API response reports a newer app version', async () => {
    resetServerVersionForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/channels/general')) {
        return new Response('channel unavailable', {
          status: 500,
          headers: { 'X-EX-App-Version': `newer-than-${BUILD_VERSION}` },
        });
      }
      return new Response(JSON.stringify({ version: BUILD_VERSION }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    function FailingChannel() {
      const [failed, setFailed] = useState(false);
      useEffect(() => {
        void apiFetch('/api/v1/channels/general').catch(() => setFailed(true));
      }, []);
      if (!failed) return <div>Checking channel</div>;
      return <ResourceErrorPage resource="channel" status={500} />;
    }

    try {
      const screen = await renderWithProviders(
        <MemoryRouter initialEntries={['/channel/general']}>
          <div style={{ height: 640 }}>
            <AppLayout>
              <FailingChannel />
            </AppLayout>
          </div>
        </MemoryRouter>,
      );

      await expect.element(screen.getByText('Channel unavailable')).toBeVisible();
      await expect.element(screen.getByTestId('update-banner-reload')).toBeVisible();
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith('/api/v1/channels/general', expect.any(Object));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
