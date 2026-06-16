import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockSystemRole: 'admin' | 'member' | 'guest' = 'admin';
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@x.com', displayName: 'A', systemRole: mockSystemRole, status: 'active' },
    isAuthenticated: true,
  }),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const copyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: copyMock }));

const usersBatchMap = vi.hoisted(() => new Map<string, { id: string; displayName: string }>());
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: usersBatchMap }),
}));

import IncomingWebhooksPage from '@/pages/IncomingWebhooksPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <IncomingWebhooksPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockSystemRole = 'admin';
  mockApiFetch.mockReset();
  copyMock.mockClear();
  usersBatchMap.clear();
});

describe('IncomingWebhooksPage', () => {
  it('shows access-denied for non-admins', () => {
    mockSystemRole = 'member';
    renderPage();
    expect(screen.getByText(/admin access required/i)).toBeInTheDocument();
  });

  it('renders the page heading for admins', async () => {
    mockApiFetch.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByRole('heading', { name: /Incoming webhooks/i })).toBeInTheDocument();
  });

  it('creates incoming webhooks', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 }]);
      }
      if (path === '/api/v1/admin/webhooks' && init?.method === 'POST') {
        return Promise.resolve({ id: 'wh-1', url: 'https://chat.example/hooks/wh-1', ...JSON.parse(init.body ?? '{}') });
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Title$/i), { target: { value: 'CI' } });
    fireEvent.change(screen.getByLabelText(/Profile picture URL/i), { target: { value: 'https://example.com/icon.png' } });
    fireEvent.click(screen.getByRole('button', { name: /Create webhook/i }));

    await waitFor(() => {
      const postCall = mockApiFetch.mock.calls.find(
        (c) => c[0] === '/api/v1/admin/webhooks' && c[1]?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1].body) as Record<string, unknown>;
      expect(body).toMatchObject({
        title: 'CI',
        channelID: 'ch-1',
        lockToChannel: true,
        profileImageURL: 'https://example.com/icon.png',
      });
    });
  });

  it('shows existing incoming webhooks and deletes them', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 }]);
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([{ id: 'wh-1', title: 'CI', url: 'https://chat.example/hooks/wh-1' }]);
      }
      if (path === '/api/v1/admin/webhooks/wh-1' && init?.method === 'DELETE') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    renderPage();

    expect(await screen.findByText('CI')).toBeInTheDocument();
    expect(screen.getByText('https://chat.example/hooks/wh-1')).toBeInTheDocument();

    // Deleting goes through a confirmation dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Delete CI' }));
    fireEvent.click(await screen.findByRole('button', { name: /Delete webhook/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/webhooks/wh-1', { method: 'DELETE' });
    });
  });

  it('cancels a delete from the confirmation dialog without deleting', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 }]);
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([{ id: 'wh-1', title: 'CI', url: 'https://chat.example/hooks/wh-1' }]);
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete CI' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));

    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/admin/webhooks/wh-1', { method: 'DELETE' });
  });

  it('edits an existing webhook', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 }]);
      }
      if (path === '/api/v1/admin/webhooks/wh-1' && init?.method === 'PATCH') {
        return Promise.resolve({ id: 'wh-1', url: 'https://chat.example/hooks/wh-1', ...JSON.parse(init.body ?? '{}') });
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([
          { id: 'wh-1', title: 'CI', channelID: 'ch-1', channelSlug: 'general', lockToChannel: true, username: 'CI Bot', url: 'https://chat.example/hooks/wh-1' },
        ]);
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit CI' }));
    const title = screen.getByLabelText(/^Title$/i) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe('CI'));
    fireEvent.change(title, { target: { value: 'CI Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const patch = mockApiFetch.mock.calls.find(
        (c) => c[0] === '/api/v1/admin/webhooks/wh-1' && c[1]?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch![1].body).title).toBe('CI Renamed');
    });
  });

  it('surfaces incoming webhook creation errors', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 }]);
      }
      if (path === '/api/v1/admin/webhooks' && init?.method === 'POST') {
        return Promise.reject(new Error('title already exists'));
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Title$/i), { target: { value: 'CI' } });
    fireEvent.click(screen.getByRole('button', { name: /Create webhook/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('title already exists');
  });

  it('offers all public channels plus the admin memberships in the picker', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-priv', channelName: 'secret', channelType: 'private', role: 3 }]);
      }
      if (path.startsWith('/api/v1/channels/browse')) {
        return Promise.resolve([{ id: 'ch-pub', name: 'announce', slug: 'announce', type: 'public', createdBy: 'x', archived: false, createdAt: '' }]);
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });
    renderPage();

    const select = (await screen.findByLabelText(/^Channel$/i)) as HTMLSelectElement;
    await waitFor(() => {
      const labels = Array.from(select.options).map((o) => o.textContent);
      expect(labels).toEqual(expect.arrayContaining(['announce', 'secret']));
    });
  });

  it('surfaces lock state, target channel and creator, and copies the URL', async () => {
    usersBatchMap.set('admin-1', { id: 'admin-1', displayName: 'Günter' });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 }]);
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([
          { id: 'wh-1', title: 'Locked CI', url: 'https://chat.example/hooks/wh-1', channelSlug: 'general', lockToChannel: true, username: 'CI Bot', createdBy: 'admin-1' },
          { id: 'wh-2', title: 'Open CI', url: 'https://chat.example/hooks/wh-2', channelID: 'ch-raw', lockToChannel: false, createdBy: 'gone' },
        ]);
      }
      return Promise.resolve({});
    });
    renderPage();

    expect(await screen.findByText('~general')).toBeInTheDocument();
    expect(screen.getByText(/Locked to channel/i)).toBeInTheDocument();
    expect(screen.getByText('~ch-raw')).toBeInTheDocument();
    expect(screen.getByText(/Channel override allowed/i)).toBeInTheDocument();
    // The creator is surfaced (resolved name + fallback for unknown ids).
    expect(screen.getByText('Created by Günter')).toBeInTheDocument();
    expect(screen.getByText('Created by unknown')).toBeInTheDocument();
    // The redundant "as <username>" line is intentionally gone.
    expect(screen.queryByText(/as webhook/i)).not.toBeInTheDocument();

    const copyButtons = screen.getAllByRole('button', { name: /^Copy .* URL$/i });
    fireEvent.click(copyButtons[0]);
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith('https://chat.example/hooks/wh-1'));
    expect(await screen.findByRole('button', { name: /Copied/i })).toBeInTheDocument();
  });

  it('resets the copied checkmark a couple of seconds after copying', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 }]);
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([{ id: 'wh-1', title: 'CI', url: 'https://chat.example/hooks/wh-1' }]);
      }
      return Promise.resolve({});
    });
    renderPage();

    const copyBtn = await screen.findByRole('button', { name: /^Copy .* URL$/i });

    vi.useFakeTimers();
    try {
      fireEvent.click(copyBtn);
      // Flush the async clipboard write so the checkmark appears.
      await act(async () => {});
      expect(screen.getByRole('button', { name: /Copied/i })).toBeInTheDocument();

      // After the reset delay it reverts to the plain copy button.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByRole('button', { name: /^Copy .* URL$/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Copied/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
