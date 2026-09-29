import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminLayout from '@/pages/AdminLayout';
import AdminAgentsPage from '@/pages/AdminAgentsPage';
import { ADMIN_TABS, ADMIN_HOME, isAdminPath } from '@/lib/admin-tabs';

const mockApiFetch = vi.fn<(path: string) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string) => mockApiFetch(path),
}));

let mockUser: { id: string; systemRole?: string } | undefined;
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<div data-testid="page-workspace" />} />
            <Route path="agents" element={<AdminAgentsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUser = { id: 'u-1', systemRole: 'admin' };
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue([]);
});

describe('AdminLayout', () => {
  it('renders the tab strip with the current tab active', () => {
    renderAt('/admin');
    expect(screen.getByRole('navigation', { name: 'Admin sections' })).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Workspace', 'Agents']);
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('page-workspace')).toBeInTheDocument();
  });

  // /admin is a PREFIX of /admin/agents, so the Workspace tab carries `end`.
  // Without it both tabs would read as active on the Agents page — the AI hub
  // never needs this because its three paths are siblings.
  it('does not leave the Workspace tab active on a child route', () => {
    renderAt('/admin/agents');
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Workspace' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Workspace' }).className).not.toContain('font-semibold');
  });

  it('switches pages when a tab is clicked', () => {
    renderAt('/admin');
    fireEvent.click(screen.getByRole('link', { name: 'Agents' }));
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
  });

  // Guarded here as well as on each page: a non-admin who types the URL must
  // not be shown a tab strip advertising pages they cannot open. Every route
  // behind these tabs is admin-gated server-side too.
  it.each([
    ['member', { id: 'u-2', systemRole: 'member' }],
    ['signed out', undefined],
  ])('refuses a %s and renders no tabs', (_label, user) => {
    mockUser = user;
    renderAt('/admin/agents');
    expect(screen.getByText('Admin access required.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Admin sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('admin-tabs', () => {
  it('ADMIN_HOME is the first tab', () => {
    expect(ADMIN_HOME).toBe('/admin');
    expect(ADMIN_TABS[0].to).toBe(ADMIN_HOME);
  });

  it('isAdminPath covers the admin area and nothing else', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/agents')).toBe(true);
    // A sibling route that merely starts with the same letters is not admin.
    expect(isAdminPath('/administrators')).toBe(false);
    expect(isAdminPath('/agents')).toBe(false);
  });
});

describe('AdminAgentsPage', () => {
  it('renders the agents panel under its own heading', async () => {
    renderAt('/admin/agents');
    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText(/Defaults every member inherits unless they set their own/),
    ).toBeInTheDocument();
  });
});
