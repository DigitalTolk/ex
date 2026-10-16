import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProjectsPage from '@/pages/ProjectsPage';
import type { ProjectSummary } from '@/hooks/useProjects';

type ApiInit = { method?: string; body?: string };
const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function projects(): ProjectSummary[] {
  return [
    {
      key: 'acme', name: 'Acme', repos: [], createdBy: 'u-1', createdAt: daysAgo(10), updatedAt: daysAgo(1),
      description: 'Bookings for clients', screenCount: 1, oldestScreenAt: daysAgo(2),
    },
    {
      key: 'beta', name: 'Beta', repos: [], createdBy: 'u-1', createdAt: daysAgo(10), updatedAt: daysAgo(1),
      appURL: 'https://beta.example.com', screenCount: 3, oldestScreenAt: daysAgo(200),
    },
    { key: 'gamma', name: 'Gamma', repos: [], createdBy: 'u-1', createdAt: daysAgo(10), updatedAt: daysAgo(1), screenCount: 0 },
  ];
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects']}>
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:key" element={<div data-testid="detail-route" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('ProjectsPage', () => {
  it('lists projects with screen counts and freshness', async () => {
    mockApiFetch.mockImplementation(async (path) => (path === '/api/v1/projects' ? { projects: projects() } : {}));
    renderPage();
    expect(screen.getByTestId('projects-loading')).toBeInTheDocument();
    const acme = await screen.findByTestId('project-row-acme');
    expect(acme).toHaveAttribute('href', '/projects/acme');
    expect(acme).toHaveTextContent('Bookings for clients');
    expect(acme).toHaveTextContent('1 screen');
    expect(acme).toHaveTextContent('Oldest 2 days ago');
    const beta = screen.getByTestId('project-row-beta');
    expect(beta).toHaveTextContent('https://beta.example.com');
    expect(beta).toHaveTextContent('3 screens');
    expect(beta).toHaveTextContent('Oldest may be outdated');
    const gamma = screen.getByTestId('project-row-gamma');
    expect(gamma).toHaveTextContent('No description yet');
    expect(gamma).not.toHaveTextContent('Oldest');
  });

  it('shows the empty state', async () => {
    mockApiFetch.mockResolvedValue({ projects: null });
    renderPage();
    expect(await screen.findByTestId('projects-empty')).toBeInTheDocument();
  });

  it('creates a project and opens it', async () => {
    const posted: unknown[] = [];
    mockApiFetch.mockImplementation(async (path, init) => {
      if (init?.method === 'POST' && path === '/api/v1/projects') {
        posted.push(JSON.parse(init.body!));
        return { project: { key: 'booking-portal' } };
      }
      return { projects: [] };
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    expect(screen.queryByTestId('projects-empty')).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create project' });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: ' Booking Portal ' } });
    fireEvent.change(screen.getByLabelText('App link'), { target: { value: 'https://bp.example.com ' } });
    fireEvent.change(screen.getByLabelText('What it is and who uses it'), { target: { value: 'Bookings' } });
    fireEvent.click(create);
    expect(await screen.findByTestId('detail-route')).toBeInTheDocument();
    expect(posted).toEqual([{ name: 'Booking Portal', appURL: 'https://bp.example.com', description: 'Bookings' }]);
  });

  it('shows why a create failed and can cancel', async () => {
    mockApiFetch.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') throw new Error('project "acme" already exists');
      return { projects: [] };
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('project-create-form')).not.toBeInTheDocument());
  });

  it('reports a non-Error create failure without a message', async () => {
    mockApiFetch.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') throw 'boom';
      return { projects: [] };
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't create the project.");
  });

  it('shows Creating… while the create is in flight', async () => {
    let release!: () => void;
    mockApiFetch.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') {
        await new Promise<void>((r) => (release = r));
        return { project: { key: 'x' } };
      }
      return { projects: [] };
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
    release();
    expect(await screen.findByTestId('detail-route')).toBeInTheDocument();
  });
});
