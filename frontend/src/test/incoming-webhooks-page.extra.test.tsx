import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@x.com', displayName: 'A', systemRole: 'admin', status: 'active' },
    isAuthenticated: true,
  }),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => {}) }));
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: new Map() }),
}));

// Capture the ConfirmDialog props so the defensive arms (open-request from
// the dialog, confirm with nothing selected) can be exercised directly —
// the real dialog can never fire them.
const confirmProps = vi.hoisted(() => ({
  current: null as null | {
    onOpenChange: (o: boolean) => void;
    onConfirm: () => void;
  },
}));
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: { onOpenChange: (o: boolean) => void; onConfirm: () => void }) => {
    confirmProps.current = props;
    return null;
  },
}));

import IncomingWebhooksPage from '@/pages/IncomingWebhooksPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <IncomingWebhooksPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function routeApi(overrides: Record<string, (init?: { method?: string; body?: string }) => Promise<unknown>> = {}) {
  mockApiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    const hit = overrides[path];
    if (hit) return hit(init);
    if (path === '/api/v1/channels/browse') {
      return Promise.resolve([{ id: 'ch-1', name: 'general' }]);
    }
    if (path === '/api/v1/channels') {
      return Promise.resolve([
        // ch-1 duplicates a public channel (must dedup); ch-2 is a private
        // membership that only exists here.
        { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 },
        { channelID: 'ch-2', channelName: 'backstage', channelType: 'private', role: 3 },
      ]);
    }
    if (path === '/api/v1/admin/webhooks') {
      return Promise.resolve([]);
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  mockApiFetch.mockReset();
  confirmProps.current = null;
});

describe('IncomingWebhooksPage (channel merge + form arms)', () => {
  it('merges public channels with own memberships, deduped by id', async () => {
    routeApi();
    renderPage();

    const select = await screen.findByLabelText(/^Channel$/i);
    await waitFor(() => {
      const names = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
      expect(names).toEqual(['backstage', 'general']); // sorted, general only once
    });
  });

  it('editing a webhook without username/profile image falls back to empty fields', async () => {
    routeApi({
      '/api/v1/admin/webhooks': () =>
        Promise.resolve([{ id: 'wh-1', title: 'CI', channelID: 'ch-1', lockToChannel: true, url: 'https://x/hooks/wh-1' }]),
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Edit CI/i }));
    expect((screen.getByLabelText(/^Username$/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Profile picture URL/i) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeInTheDocument();
  });

  it('shows "Creating..." while the create mutation is in flight', async () => {
    routeApi({});
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/admin/webhooks' && init?.method === 'POST') {
        return new Promise(() => undefined); // never settles — stays pending
      }
      if (path === '/api/v1/channels/browse') return Promise.resolve([{ id: 'ch-1', name: 'general' }]);
      if (path === '/api/v1/channels') return Promise.resolve([]);
      if (path === '/api/v1/admin/webhooks') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Title$/i), { target: { value: 'CI' } });
    fireEvent.click(screen.getByRole('button', { name: /Create webhook/i }));
    expect(await screen.findByRole('button', { name: /Creating\.\.\./i })).toBeDisabled();
  });

  it('shows "Saving..." while an edit mutation is in flight', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/admin/webhooks/wh-1' && init?.method === 'PATCH') {
        return new Promise(() => undefined);
      }
      if (path === '/api/v1/channels/browse') return Promise.resolve([{ id: 'ch-1', name: 'general' }]);
      if (path === '/api/v1/channels') return Promise.resolve([]);
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([{ id: 'wh-1', title: 'CI', channelID: 'ch-1', lockToChannel: true, url: 'https://x/hooks/wh-1' }]);
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Edit CI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    expect(await screen.findByRole('button', { name: /Saving\.\.\./i })).toBeDisabled();
  });

  it('falls back to generic copy when a mutation rejects with a non-Error', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/admin/webhooks' && init?.method === 'POST') {
        return Promise.reject('boom'); // non-Error rejection
      }
      if (path === '/api/v1/channels/browse') return Promise.resolve([{ id: 'ch-1', name: 'general' }]);
      if (path === '/api/v1/channels') return Promise.resolve([]);
      if (path === '/api/v1/admin/webhooks') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Title$/i), { target: { value: 'CI' } });
    fireEvent.click(screen.getByRole('button', { name: /Create webhook/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed');
  });

  it('confirm-dialog defensive arms: open-request and confirm-with-nothing-selected are no-ops', async () => {
    routeApi();
    renderPage();
    await screen.findByLabelText(/^Channel$/i);

    // The dialog is mounted (closed, nothing selected). Firing its callbacks
    // in that state must neither crash nor issue a DELETE.
    confirmProps.current!.onOpenChange(true);
    confirmProps.current!.onConfirm();
    await waitFor(() => {
      expect(
        mockApiFetch.mock.calls.some((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE'),
      ).toBe(false);
    });
  });
});
