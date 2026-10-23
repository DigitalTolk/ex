import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

// Own file on purpose: a resolved lazy() component never suspends again, so
// this has to be the first render of the 404 route in its module graph.

const originalFetch = globalThis.fetch;

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));
vi.mock('@/pages/ChatPage', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <Outlet /> };
});
vi.mock('@/pages/NotFoundPage', () => ({ NotFoundPage: () => <div data-testid="stub-NotFoundPage" /> }));

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as Response;
}

describe('App — 404 route', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/auth/token/refresh')) return Promise.resolve(json({ accessToken: 'tok' }));
      if (u.includes('/users/me')) {
        return Promise.resolve(json({ id: 'u-1', email: 'a@b.c', displayName: 'Alice', systemRole: 'admin', status: 'active' }));
      }
      return Promise.resolve(json([]));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('renders the 404 page without a lazy-chunk loading flash', async () => {
    // ChannelView and ConversationView import NotFoundPage statically, so it
    // ships in the entry chunk anyway; a lazy() route wrapper only put a
    // Suspense fallback in front of a page that was already loaded.
    window.history.replaceState({}, '', '/no-such-page');
    const seenFallback = { value: false };
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="route-loading"]')) seenFallback.value = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      render(<App />);
      expect(await screen.findByTestId('stub-NotFoundPage')).toBeInTheDocument();
    } finally {
      observer.disconnect();
    }
    expect(seenFallback.value).toBe(false);
  });
});
