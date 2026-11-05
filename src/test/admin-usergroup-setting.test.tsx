import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'a@x.com', displayName: 'A', systemRole: 'admin', status: 'active' }, isAuthenticated: true }),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import AdminPage from '@/pages/AdminPage';
import { RunnersInAppCard } from '@/components/admin/RunnersInAppCard';

type Init = { method?: string; body?: string };

function renderWith(ui: React.ReactElement, settings: Record<string, unknown>) {
  mockApiFetch.mockImplementation((path: string, init?: Init) => {
    if (path === '/api/v1/admin/settings') {
      return Promise.resolve(init?.method === 'PUT' ? JSON.parse(init.body ?? '{}') : settings);
    }
    return Promise.resolve({ configured: false });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

function putBody() {
  const put = mockApiFetch.mock.calls.find((c) => c[0] === '/api/v1/admin/settings' && (c[1] as Init | undefined)?.method === 'PUT');
  return JSON.parse((put![1] as Init).body!) as Record<string, unknown>;
}

beforeEach(() => mockApiFetch.mockReset());

describe('who can create and edit user groups', () => {
  it('defaults to admins only and saves a change to all members', async () => {
    renderWith(<AdminPage />, { maxUploadBytes: 1024 * 1024, allowedExtensions: ['png'] });
    const select = screen.getByLabelText('Who can create and edit user groups') as HTMLSelectElement;
    // Wait for the saved settings to seed the form before changing it.
    await waitFor(() => expect((screen.getByLabelText(/Max file size/i) as HTMLInputElement).value).toBe('1'));
    expect(select.value).toBe('admins');
    fireEvent.change(select, { target: { value: 'members' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings for all workspace sections' }));
    await waitFor(() => expect(putBody().userGroupManagers).toBe('members'));
  });

  it('shows the saved choice', async () => {
    renderWith(<AdminPage />, { maxUploadBytes: 1024 * 1024, allowedExtensions: ['png'], userGroupManagers: 'members' });
    await waitFor(() => expect((screen.getByLabelText('Who can create and edit user groups') as HTMLSelectElement).value).toBe('members'));
  });

  it('is kept when the Runners switch saves the settings', async () => {
    renderWith(<RunnersInAppCard />, { maxUploadBytes: 1024, allowedExtensions: ['png'], userGroupManagers: 'members' });
    fireEvent.click(await screen.findByTestId('runners-in-app-switch'));
    await waitFor(() => expect(putBody().userGroupManagers).toBe('members'));
  });
});
