import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

import AdminPage from '@/pages/AdminPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AdminPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockSystemRole = 'admin';
  mockApiFetch.mockReset();
  copyMock.mockClear();
});

describe('AdminPage', () => {
  it('shows access-denied for non-admins', () => {
    mockSystemRole = 'member';
    renderPage();
    expect(screen.getByText(/admin access required/i)).toBeInTheDocument();
  });

  it('renders form fields seeded with current settings', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({
          maxUploadBytes: 50 * 1024 * 1024,
          allowedExtensions: ['png', 'jpg'],
        });
      }
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      return Promise.resolve({});
    });
    renderPage();

    const maxInput = screen.getByLabelText(/Max file size/i) as HTMLInputElement;
    const extInput = screen.getByLabelText(/Allowed file extensions/i) as HTMLInputElement;

    await waitFor(() => {
      expect(maxInput.value).toBe('50');
      expect(extInput.value).toBe('png, jpg');
    });
  });

  it('places the single save settings action in the page header', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      return Promise.resolve({});
    });
    renderPage();

    await screen.findByLabelText(/Max file size/i);
    const saveButtons = screen.getAllByRole('button', { name: /Save settings/i });
    expect(saveButtons).toHaveLength(1);
    const header = screen.getByRole('heading', { name: /Workspace settings/i }).closest('header');
    expect(header).not.toBeNull();
    expect(header).toContainElement(saveButtons[0]);
  });

  it('seeds and PUTs the Giphy API key, surfacing the enabled-state copy', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      if (path === '/api/v1/admin/settings' && (!init || init.method !== 'PUT')) {
        return Promise.resolve({
          maxUploadBytes: 50 * 1024 * 1024,
          allowedExtensions: ['png'],
          giphyAPIKey: 'existing-key',
          giphyEnabled: true,
        });
      }
      return Promise.resolve(JSON.parse(init?.body ?? '{}'));
    });
    renderPage();

    const giphyInput = (await screen.findByLabelText(/Giphy API key/i)) as HTMLInputElement;
    await waitFor(() => expect(giphyInput.value).toBe('existing-key'));
    expect(screen.getByText(/Giphy is enabled/i)).toBeInTheDocument();

    fireEvent.change(giphyInput, { target: { value: '  rotated-key  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() => {
      const putCall = mockApiFetch.mock.calls.find(
        (c) => c[0] === '/api/v1/admin/settings' && c[1]?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1].body) as Record<string, unknown>;
      // Composer trims whitespace before sending.
      expect(body.giphyAPIKey).toBe('rotated-key');
    });
  });

  it('PUTs converted bytes + cleaned extension list on save', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      if (path === '/api/v1/admin/settings' && (!init || init.method !== 'PUT')) {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      return Promise.resolve(JSON.parse(init?.body ?? '{}'));
    });
    renderPage();

    const maxInput = await screen.findByLabelText(/Max file size/i);
    const extInput = await screen.findByLabelText(/Allowed file extensions/i);

    fireEvent.change(maxInput, { target: { value: '20' } });
    fireEvent.change(extInput, { target: { value: ' .PNG, jpg ,  ,pdf' } });
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() => {
      const putCall = mockApiFetch.mock.calls.find(
        (c) => c[0] === '/api/v1/admin/settings' && c[1]?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1].body) as Record<string, unknown>;
      expect(body.maxUploadBytes).toBe(20 * 1024 * 1024);
      expect(body.allowedExtensions).toEqual(['png', 'jpg', 'pdf']);
    });
  });

  it('creates incoming webhooks from the admin panel', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
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
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
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
    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/webhooks/wh-1', { method: 'DELETE' });
    });
  });

  it('surfaces incoming webhook creation errors', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
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
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
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

  it('surfaces lock state, target channel and username, and copies the URL', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      if (path === '/api/v1/channels') {
        return Promise.resolve([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 3 }]);
      }
      if (path === '/api/v1/admin/webhooks') {
        return Promise.resolve([
          { id: 'wh-1', title: 'Locked CI', url: 'https://chat.example/hooks/wh-1', channelSlug: 'general', lockToChannel: true, username: 'CI Bot' },
          { id: 'wh-2', title: 'Open CI', url: 'https://chat.example/hooks/wh-2', channelID: 'ch-raw', lockToChannel: false },
        ]);
      }
      return Promise.resolve({});
    });
    renderPage();

    expect(await screen.findByText('~general')).toBeInTheDocument();
    expect(screen.getByText(/Locked to channel/i)).toBeInTheDocument();
    expect(screen.getByText(/as CI Bot/i)).toBeInTheDocument();
    // Second webhook falls back to channel id, override-allowed, default name.
    expect(screen.getByText('~ch-raw')).toBeInTheDocument();
    expect(screen.getByText(/Channel override allowed/i)).toBeInTheDocument();
    expect(screen.getByText(/as webhook/i)).toBeInTheDocument();

    const copyButtons = screen.getAllByRole('button', { name: /^Copy$/i });
    fireEvent.click(copyButtons[0]);
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith('https://chat.example/hooks/wh-1'));
    expect(await screen.findByRole('button', { name: /Copied/i })).toBeInTheDocument();
  });
});
