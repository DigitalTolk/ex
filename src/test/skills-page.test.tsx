import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SkillsPage from '@/pages/SkillsPage';
import type { Skill } from '@/hooks/useAgents';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

let mockUser: { id: string } | undefined;
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

function skillFixtures(): Skill[] {
  return [
    {
      id: 'sk-1',
      name: 'release-notes',
      description: 'Format release notes',
      instructions: 'Step 1: gather MRs',
      createdBy: 'u-1',
      createdAt: '2026-01-05T10:00:00Z',
      updatedAt: '2026-02-11T09:30:00Z',
    },
    {
      id: 'sk-2',
      name: 'triage',
      description: 'Bug triage flow',
      instructions: 'Label severity first',
      createdBy: 'u-2',
      createdAt: '2026-01-06T10:00:00Z',
      updatedAt: '2026-02-12T09:30:00Z',
    },
  ];
}

interface Routes {
  skills?: () => Promise<unknown>;
  mutate?: (path: string, init?: ApiInit) => Promise<unknown> | undefined;
}

function installRoutes(over: Routes = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (!init?.method && path === '/api/v1/skills') {
      return (over.skills ?? (async () => ({ skills: skillFixtures() })))();
    }
    return over.mutate?.(path, init) ?? Promise.resolve({});
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SkillsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockUser = { id: 'u-1' };
});

describe('SkillsPage', () => {
  it('shows loading skeletons while skills load', () => {
    installRoutes({ skills: () => new Promise(() => {}) });
    renderPage();
    expect(screen.getByTestId('skills-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('skills-empty')).not.toBeInTheDocument();
  });

  it('shows the empty state when the server returns no skills, hiding it while creating', async () => {
    installRoutes({ skills: async () => ({}) });
    renderPage();
    expect(await screen.findByTestId('skills-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    expect(screen.getByTestId('skill-form')).toBeInTheDocument();
    expect(screen.queryByTestId('skills-empty')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('skill-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('skills-empty')).toBeInTheDocument();
  });

  it('shows the empty state when the skills query errors', async () => {
    installRoutes({ skills: () => Promise.reject(new Error('boom')) });
    renderPage();
    expect(await screen.findByTestId('skills-empty')).toBeInTheDocument();
  });

  it('renders skill cards and only shows edit/delete to the author', async () => {
    installRoutes();
    renderPage();

    const mine = within(await screen.findByTestId('skill-card-release-notes'));
    expect(mine.getByText('Format release notes')).toBeInTheDocument();
    expect(mine.getByText('Step 1: gather MRs')).toBeInTheDocument();
    expect(mine.getByText(/^updated /)).toBeInTheDocument();
    expect(mine.getByLabelText('Edit release-notes')).toBeInTheDocument();
    expect(mine.getByLabelText('Delete release-notes')).toBeInTheDocument();

    const theirs = within(screen.getByTestId('skill-card-triage'));
    expect(theirs.queryByLabelText('Edit triage')).not.toBeInTheDocument();
    expect(theirs.queryByLabelText('Delete triage')).not.toBeInTheDocument();
  });

  it('hides owner controls when there is no signed-in user', async () => {
    mockUser = undefined;
    installRoutes();
    renderPage();
    await screen.findByTestId('skill-card-release-notes');
    expect(screen.queryByLabelText('Edit release-notes')).not.toBeInTheDocument();
  });

  it('creates a skill: validation gates, error shapes, pending state, success', async () => {
    const bodies: unknown[] = [];
    let createResult: () => Promise<unknown> = async () => ({});
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/skills' && init?.method === 'POST') {
          bodies.push(JSON.parse(init.body!));
          return createResult();
        }
        return undefined;
      },
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }));
    const form = within(screen.getByTestId('skill-form'));

    const createBtn = () => form.getByRole('button', { name: 'Create skill' });
    expect(createBtn()).toBeDisabled();
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'test-skill' } });
    expect(createBtn()).toBeDisabled();
    fireEvent.change(form.getByLabelText('Description'), { target: { value: 'When testing' } });
    expect(createBtn()).toBeDisabled();
    fireEvent.change(form.getByLabelText('Instructions'), { target: { value: 'do things' } });
    expect(form.getByText('9/8192')).toBeInTheDocument();
    expect(createBtn()).toBeEnabled();

    createResult = () => Promise.reject('x');
    fireEvent.click(createBtn());
    expect(await form.findByText('Save failed.')).toBeInTheDocument();

    createResult = () => Promise.reject(new Error('name taken'));
    fireEvent.click(createBtn());
    expect(await form.findByText('Save failed: name taken.')).toBeInTheDocument();

    const d = deferred<unknown>();
    createResult = () => d.promise;
    fireEvent.click(createBtn());
    expect(await form.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    d.resolve({ skill: skillFixtures()[0] });
    await waitFor(() => expect(screen.queryByTestId('skill-form')).not.toBeInTheDocument());

    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toEqual({
      name: 'test-skill',
      description: 'When testing',
      instructions: 'do things',
    });
  });

  it('edits an own skill, surfacing an update failure before succeeding', async () => {
    const bodies: unknown[] = [];
    let updateResult: () => Promise<unknown> = async () => ({ skill: skillFixtures()[0] });
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/skills/sk-1' && init?.method === 'PATCH') {
          bodies.push(JSON.parse(init.body!));
          return updateResult();
        }
        return undefined;
      },
    });
    renderPage();

    await screen.findByTestId('skill-card-release-notes');
    fireEvent.click(screen.getByLabelText('Edit release-notes'));
    const form = within(screen.getByTestId('skill-form'));

    // Prefilled from the existing skill; the CTA reads "Save changes".
    expect(form.getByLabelText('Name')).toHaveValue('release-notes');
    expect(form.getByLabelText('Description')).toHaveValue('Format release notes');
    expect(form.getByLabelText('Instructions')).toHaveValue('Step 1: gather MRs');

    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'release-notes-v2' } });

    updateResult = () => Promise.reject(new Error('locked'));
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    expect(await form.findByText('Save failed: locked.')).toBeInTheDocument();

    updateResult = async () => ({ skill: skillFixtures()[0] });
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByTestId('skill-form')).not.toBeInTheDocument());
    expect(screen.getByTestId('skill-card-release-notes')).toBeInTheDocument();

    expect(bodies).toEqual([
      { name: 'release-notes-v2', description: 'Format release notes', instructions: 'Step 1: gather MRs' },
      { name: 'release-notes-v2', description: 'Format release notes', instructions: 'Step 1: gather MRs' },
    ]);
  });

  it('deletes an own skill behind a confirm step that can be cancelled', async () => {
    const deletes: string[] = [];
    let skillsPayload: unknown = { skills: skillFixtures() };
    installRoutes({
      skills: () => Promise.resolve(skillsPayload),
      mutate: (path, init) => {
        if (init?.method === 'DELETE') {
          deletes.push(path);
          return Promise.resolve({});
        }
        return undefined;
      },
    });
    renderPage();

    await screen.findByTestId('skill-card-release-notes');
    fireEvent.click(screen.getByLabelText('Delete release-notes'));
    const confirm = screen.getByRole('button', { name: 'Delete “release-notes”?' });
    expect(confirm).toBeInTheDocument();

    // Backing out restores the edit/delete icons without deleting anything.
    fireEvent.click(screen.getByLabelText('Cancel delete'));
    expect(screen.queryByRole('button', { name: 'Delete “release-notes”?' })).not.toBeInTheDocument();
    expect(deletes).toHaveLength(0);

    fireEvent.click(screen.getByLabelText('Delete release-notes'));
    skillsPayload = { skills: [skillFixtures()[1]] };
    fireEvent.click(screen.getByRole('button', { name: 'Delete “release-notes”?' }));

    await waitFor(() => expect(deletes).toEqual(['/api/v1/skills/sk-1']));
    await waitFor(() =>
      expect(screen.queryByTestId('skill-card-release-notes')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('skill-card-triage')).toBeInTheDocument();
  });
});
