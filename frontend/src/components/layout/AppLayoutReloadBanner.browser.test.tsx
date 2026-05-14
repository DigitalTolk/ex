import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { AppLayout } from './AppLayout';
import ChatPage from '@/pages/ChatPage';
import LoginPage from '@/pages/LoginPage';
import { ChannelView } from '@/components/chat/ChannelView';
import { ResourceErrorPage } from '@/pages/ResourceErrorPage';
import { BUILD_VERSION, resetServerVersionForTests, setServerVersion } from '@/hooks/useServerVersion';
import { apiFetch } from '@/lib/api';
import { UnreadProvider } from '@/context/UnreadContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { TypingProvider } from '@/context/TypingContext';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

vi.mock('@/context/AuthContext', async () => {
  const actual = await vi.importActual<typeof import('@/context/AuthContext')>('@/context/AuthContext');
  return {
    ...actual,
    useAuth: () => ({
      user: { id: 'u-me', displayName: 'Me', email: 'me@example.test', systemRole: 'member', status: 'active' },
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      setAuth: vi.fn(),
      patchUser: vi.fn(),
    }),
  };
});

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

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

function renderChatRoute(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UnreadProvider>
        <PresenceProvider>
          <NotificationProvider>
            <TypingProvider>
              {ui}
            </TypingProvider>
          </NotificationProvider>
        </PresenceProvider>
      </UnreadProvider>
    </QueryClientProvider>,
  );
}

function apiJSON(body: unknown, version = BUILD_VERSION): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-EX-App-Version': version,
    },
  });
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
    expectPaintedAtCenter(banner!, '[data-testid="update-banner"]');
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
      if (url.includes('/api/v1/version')) {
        return new Response(JSON.stringify({ version: `newer-than-${BUILD_VERSION}` }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-EX-App-Version': `newer-than-${BUILD_VERSION}`,
          },
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
      await vi.waitFor(() => {
        expect(vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]))).toContain('/api/v1/channels/general');
      });
      await expect.element(screen.getByTestId('update-banner-reload')).toBeVisible();
      const banner = document.querySelector('[data-testid="update-banner"]') as HTMLElement | null;
      expect(banner).not.toBeNull();
      expectPaintedAtCenter(banner!, '[data-testid="update-banner"]');
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith('/api/v1/channels/general', expect.any(Object));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('shows the reload banner on the real mobile chat route when the channel request fails with a newer app version', async () => {
    resetServerVersionForTests();
    const newerVersion = `newer-than-${BUILD_VERSION}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/channels/general')) {
        return new Response('channel unavailable', {
          status: 500,
          headers: { 'X-EX-App-Version': newerVersion },
        });
      }
      if (url.includes('/api/v1/channels')) return apiJSON([]);
      if (url.includes('/api/v1/conversations')) return apiJSON([]);
      if (url.includes('/api/v1/sidebar/categories')) return apiJSON([]);
      if (url.includes('/api/v1/drafts')) return apiJSON([]);
      if (url.includes('/api/v1/user-state')) {
        return apiJSON({ channelNotifications: [], threadNotifications: [], threadSeen: {}, hiddenConversations: [] });
      }
      if (url.includes('/api/v1/threads')) return apiJSON([]);
      if (url.includes('/api/v1/version')) return apiJSON({ version: newerVersion }, newerVersion);
      return apiJSON([]);
    }) as typeof fetch;

    try {
      const screen = await renderChatRoute(
        <MemoryRouter initialEntries={['/channel/general']}>
          <div style={{ height: 640 }}>
            <Routes>
              <Route path="/" element={<ChatPage />}>
                <Route path="channel/:id" element={<ChannelView />} />
              </Route>
            </Routes>
          </div>
        </MemoryRouter>,
      );

      await expect.element(screen.getByText('Channel unavailable')).toBeVisible();
      await expect.element(screen.getByTestId('update-banner-reload')).toBeVisible();
      const banner = document.querySelector('[data-testid="update-banner"]') as HTMLElement | null;
      const error = document.querySelector('[data-testid="resource-error-500"]') as HTMLElement | null;
      expect(banner).not.toBeNull();
      expect(error).not.toBeNull();
      expect(banner!.getBoundingClientRect().bottom).toBeLessThanOrEqual(error!.getBoundingClientRect().top + 1);
      expectPaintedAtCenter(banner!, '[data-testid="update-banner"]');
      if (window.innerWidth <= 767) {
        const mobileSidebar = document.querySelector('[data-testid="mobile-channel-sidebar"]') as HTMLElement | null;
        expect(mobileSidebar).not.toBeNull();
        expect(mobileSidebar!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          banner!.getBoundingClientRect().bottom - 1,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the reload banner mounted while the mobile chat ready gate is still loading', async () => {
    resetServerVersionForTests();
    const newerVersion = `newer-than-${BUILD_VERSION}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/version')) return apiJSON({ version: newerVersion }, newerVersion);
      if (
        url.includes('/api/v1/channels') ||
        url.includes('/api/v1/conversations') ||
        url.includes('/api/v1/sidebar/categories') ||
        url.includes('/api/v1/drafts') ||
        url.includes('/api/v1/user-state') ||
        url.includes('/api/v1/threads')
      ) {
        return new Promise<Response>(() => undefined);
      }
      return apiJSON([]);
    }) as typeof fetch;

    try {
      const screen = await renderChatRoute(
        <MemoryRouter initialEntries={['/channel/general']}>
          <div style={{ height: 640 }}>
            <Routes>
              <Route path="/" element={<ChatPage />}>
                <Route path="channel/:id" element={<div>Channel ready</div>} />
              </Route>
            </Routes>
          </div>
        </MemoryRouter>,
      );

      await expect.element(screen.getByTestId('update-banner-reload')).toBeVisible();
      const banner = document.querySelector('[data-testid="update-banner"]') as HTMLElement | null;
      expect(banner).not.toBeNull();
      expectPaintedAtCenter(banner!, '[data-testid="update-banner"]');
      if (window.innerWidth <= 767) {
        const loading = screen.getByTestId('mobile-chat-loading');
        await expect.element(loading).toBeVisible();
        expect(loading.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
          banner!.getBoundingClientRect().bottom - 1,
        );
      } else {
        await expect.element(screen.getByText('Channel ready')).toBeVisible();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('shows the reload banner on the mobile auth error surface when login reports a newer app version', { retry: 2 }, async () => {
    resetServerVersionForTests();
    const newerVersion = `newer-than-${BUILD_VERSION}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/login')) {
        return new Response(JSON.stringify({ error: 'missing or invalid token' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'X-EX-App-Version': newerVersion,
          },
        });
      }
      if (url.includes('/api/v1/version')) return apiJSON({ version: BUILD_VERSION });
      return apiJSON({});
    }) as typeof fetch;

    try {
      const screen = await renderWithProviders(
        <MemoryRouter initialEntries={['/login']}>
          <LoginPage />
        </MemoryRouter>,
      );

      await screen.getByLabelText('Email').fill('me@example.test');
      await screen.getByLabelText('Password').fill('password123');
      await screen.getByRole('button', { name: 'Sign in', exact: true }).click();

      await expect.element(screen.getByText('missing or invalid token')).toBeVisible();
      const reload = screen.getByTestId('update-banner-reload');
      await expect.element(reload).toBeVisible();

      const banner = document.querySelector('[data-testid="update-banner"]') as HTMLElement | null;
      const alert = screen.getByText('missing or invalid token').element().closest('[role="alert"]') as HTMLElement | null;
      expect(banner).not.toBeNull();
      expect(alert).not.toBeNull();
      expect(banner!.getBoundingClientRect().bottom).toBeLessThanOrEqual(alert!.getBoundingClientRect().top);
      expectPaintedAtCenter(banner!, '[data-testid="update-banner"]');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
