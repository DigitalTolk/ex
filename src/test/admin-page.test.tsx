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

import AdminPage from '@/pages/AdminPage';
import { queryKeys } from '@/lib/query-keys';

function renderPage(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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

  it('seeds the form synchronously when settings are already cached', () => {
    // Navigating back to /admin re-mounts the page with the React Query
    // cache warm — the useState initializers must seed from that data on the
    // very first render instead of flashing the fallbacks.
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      return Promise.resolve({});
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.workspaceSettings(), {
      maxUploadBytes: 25 * 1024 * 1024,
      allowedExtensions: ['gif', 'webp'],
      giphyAPIKey: 'cached-key',
      giphyEnabled: true,
    });
    renderPage(qc);

    // No waitFor: the values must be present on first paint.
    expect((screen.getByLabelText(/Max file size/i) as HTMLInputElement).value).toBe('25');
    expect((screen.getByLabelText(/Allowed file extensions/i) as HTMLInputElement).value).toBe('gif, webp');
    expect((screen.getByLabelText(/Giphy API key/i) as HTMLInputElement).value).toBe('cached-key');
  });

  it('sends maxUploadBytes=0 when the size field is cleared (server-side default)', async () => {
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

    const maxInput = (await screen.findByLabelText(/Max file size/i)) as HTMLInputElement;
    // Wait for the server payload to seed the form before editing —
    // otherwise the late fetch would overwrite the cleared value.
    await waitFor(() => expect(maxInput.value).toBe('50'));
    fireEvent.change(maxInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() => {
      const putCall = mockApiFetch.mock.calls.find(
        (c) => c[0] === '/api/v1/admin/settings' && c[1]?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1].body) as Record<string, unknown>;
      expect(body.maxUploadBytes).toBe(0);
    });
  });

  it('shows a Saving… state while the update is in flight', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      if (path === '/api/v1/admin/settings' && init?.method === 'PUT') {
        return new Promise(() => undefined); // hangs — stays pending
      }
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      return Promise.resolve({});
    });
    renderPage();

    await screen.findByLabelText(/Max file size/i);
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    const saving = await screen.findByRole('button', { name: /Save settings for all workspace sections/i });
    await waitFor(() => {
      expect(saving).toHaveTextContent('Saving...');
      expect(saving).toBeDisabled();
    });
  });

  it('surfaces the error message when the save is rejected with an Error', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      if (path === '/api/v1/admin/settings' && init?.method === 'PUT') {
        return Promise.reject(new Error('settings locked'));
      }
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      return Promise.resolve({});
    });
    renderPage();

    await screen.findByLabelText(/Max file size/i);
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('settings locked');
  });

  it('falls back to a generic message when the save rejection is not an Error', async () => {
    mockApiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/v1/admin/search/status') {
        return Promise.resolve({ configured: false });
      }
      if (path === '/api/v1/admin/settings' && init?.method === 'PUT') {
        return Promise.reject('boom'); // non-Error rejection
      }
      if (path === '/api/v1/admin/settings') {
        return Promise.resolve({ maxUploadBytes: 50 * 1024 * 1024, allowedExtensions: ['png'] });
      }
      return Promise.resolve({});
    });
    renderPage();

    await screen.findByLabelText(/Max file size/i);
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Save failed');
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
});
