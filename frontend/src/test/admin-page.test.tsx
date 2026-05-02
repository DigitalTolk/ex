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
});
