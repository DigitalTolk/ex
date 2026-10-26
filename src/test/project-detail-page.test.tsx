import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useProject } from '@/hooks/useProjects';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProjectDetailPage from '@/pages/ProjectDetailPage';
import type { ProjectDetail } from '@/hooks/useProjects';
import { DESIGN_NOTES_TEMPLATE } from '@/lib/project-screens';

type ApiInit = { method?: string; body?: string };
const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));
vi.mock('@/components/projects/ScreensTab', () => ({
  ScreensTab: ({ projectKey, screens }: { projectKey: string; screens: unknown[] }) => (
    <div data-testid="screens-tab">
      {projectKey}:{screens.length}
    </div>
  ),
}));

function detail(over: Partial<ProjectDetail['project']> = {}, canManage = true): ProjectDetail {
  return {
    canManage,
    screens: [],
    project: {
      key: 'acme', name: 'Acme', repos: [{ path: 'grp/web', role: 'frontend' }], createdBy: 'u-1',
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over,
    },
  };
}

let current: ProjectDetail;
let patches: unknown[];
let failPatch: unknown;

function install() {
  patches = [];
  failPatch = undefined;
  mockApiFetch.mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH') {
      if (failPatch) throw failPatch;
      const body = JSON.parse(init.body!);
      patches.push(body);
      current = { ...current, project: { ...current.project, ...body } };
      return { project: current.project };
    }
    if (init?.method === 'DELETE') {
      if (failPatch) throw failPatch;
      return {};
    }
    if (path === '/api/v1/projects/acme') return current;
    throw new Error('not found');
  });
}

function renderPage(key = 'acme') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/projects/${key}`]}>
        <Routes>
          <Route path="/projects" element={<div data-testid="list-route" />} />
          <Route path="/projects/:key" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  showToast.mockReset();
  current = detail();
  install();
});

describe('ProjectDetailPage', () => {
  it('loads, then shows the screens tab by default', async () => {
    renderPage();
    expect(screen.getByTestId('project-loading')).toBeInTheDocument();
    expect(await screen.findByTestId('screens-tab')).toHaveTextContent('acme:0');
    expect(screen.getByRole('heading', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Screens/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('link', { name: /Open app/ })).not.toBeInTheDocument();
  });

  it('says so when the project does not exist', async () => {
    renderPage('ghost');
    expect(await screen.findByText(/doesn.t exist or was deleted/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute('href', '/projects');
  });

  it('links the app and deletes the project after confirming', async () => {
    current = detail({ appURL: 'https://acme.example.com', description: 'Bookings' });
    renderPage();
    expect(await screen.findByRole('link', { name: /Open app/ })).toHaveAttribute('href', 'https://acme.example.com');
    expect(screen.getByText('Bookings')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('project-delete'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByTestId('list-route')).toBeInTheDocument();
  });

  it('does not link an app URL that is not plain http(s)', async () => {
    current = detail({ appURL: 'smb://attacker.example/share', description: 'Bookings' });
    renderPage();
    expect(await screen.findByText('Bookings')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open app/ })).not.toBeInTheDocument();
  });

  it('toasts a failed delete', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('project-delete'));
    failPatch = new Error('nope');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('nope'));
    failPatch = 'odd';
    fireEvent.click(screen.getByTestId('project-delete'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Delete failed'));
  });

  it('hides delete from members who cannot manage', async () => {
    current = detail({}, false);
    renderPage();
    await screen.findByTestId('screens-tab');
    expect(screen.queryByTestId('project-delete')).not.toBeInTheDocument();
  });

  it('edits design notes starting from the template', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Design notes' }));
    const notes = screen.getByRole('textbox', { name: 'Design notes' }) as HTMLTextAreaElement;
    expect(notes.value).toBe(DESIGN_NOTES_TEMPLATE);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(notes, { target: { value: 'Font: Inter' } });
    fireEvent.click(save);
    await waitFor(() => expect(patches).toEqual([{ designNotes: 'Font: Inter' }]));
    expect(showToast).toHaveBeenCalledWith('Design notes saved', 'success');
  });

  it('shows saved notes and a failed save', async () => {
    current = detail({ designNotes: 'Radius 8' });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Design notes' }));
    const notes = screen.getByRole('textbox', { name: 'Design notes' }) as HTMLTextAreaElement;
    expect(notes.value).toBe('Radius 8');
    failPatch = new Error('too long');
    fireEvent.change(notes, { target: { value: 'Radius 6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed: too long.');
  });

  it('edits the overview: name, link, description and links', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Acme 2' } });
    fireEvent.change(screen.getByLabelText('App link'), { target: { value: 'https://a.example.com' } });
    fireEvent.change(screen.getByLabelText('What it is and who uses it'), { target: { value: 'Desc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'Figma' } });
    fireEvent.change(screen.getByLabelText('Link 1 URL'), { target: { value: 'https://figma.example.com' } });
    fireEvent.change(screen.getByLabelText('Link 2 label'), { target: { value: 'Empty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patches).toEqual([
        {
          appURL: 'https://a.example.com',
          description: 'Desc',
          links: [{ label: 'Figma', url: 'https://figma.example.com' }],
          name: 'Acme 2',
        },
      ]),
    );
    expect(showToast).toHaveBeenCalledWith('Project saved', 'success');
  });

  it('removes links and leaves the name alone for members', async () => {
    current = detail({ links: [{ label: 'A', url: 'https://a.example.com' }, { label: 'B', url: 'https://b.example.com' }] }, false);
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
    expect(screen.getByLabelText('Product name')).toBeDisabled();
    expect(screen.getByText(/Only the project.s creator or an admin can rename it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove link 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patches).toEqual([{ appURL: '', description: '', links: [{ label: 'B', url: 'https://b.example.com' }] }]),
    );
  });

  it('caps links at ten', async () => {
    current = detail({ links: Array.from({ length: 10 }, (_, i) => ({ label: `L${i}`, url: `https://${i}.example.com` })) });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
    expect(screen.queryByRole('button', { name: 'Add link' })).not.toBeInTheDocument();
  });

  it('edits repos for managers', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Repos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    fireEvent.change(screen.getByLabelText('Repo 1 role'), { target: { value: 'backend' } });
    fireEvent.change(screen.getByLabelText('Repo 2 path'), { target: { value: 'grp/api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove repo 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patches).toEqual([
        { repos: [{ path: 'grp/web', role: 'backend' }, { path: 'grp/api', role: 'frontend' }] },
      ]),
    );
    expect(showToast).toHaveBeenCalledWith('Repos saved', 'success');
  });

  it('shows repos read-only to members, including none', async () => {
    current = detail({}, false);
    const { unmount } = renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Repos' }));
    expect(screen.getByText('grp/web')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add repo' })).not.toBeInTheDocument();
    unmount();
    current = detail({ repos: undefined as unknown as [] }, false);
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Repos' }));
    expect(screen.getByText(/No repos yet/)).toBeInTheDocument();
  });

  it('reports a failed save without a message for non-Error failures', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Repos' }));
    failPatch = 'odd';
    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    fireEvent.change(screen.getByLabelText('Repo 2 path'), { target: { value: 'grp/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Save failed\.$/);
  });

  it('shows Saving… while a save is in flight, and tolerates a missing screen list', async () => {
    current = { ...detail(), screens: undefined as unknown as [] };
    let release!: () => void;
    mockApiFetch.mockImplementation(async (path, init) => {
      if (init?.method === 'PATCH') {
        await new Promise<void>((r) => (release = r));
        return { project: current.project };
      }
      if (path === '/api/v1/projects/acme') return current;
      throw new Error('not found');
    });
    renderPage();
    expect(await screen.findByTestId('screens-tab')).toHaveTextContent('acme:0');
    fireEvent.click(screen.getByRole('tab', { name: 'Design notes' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Design notes' }), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    release();
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});

describe('useProject', () => {
  it('stays idle without a key', () => {
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useProject(undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
