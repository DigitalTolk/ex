import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskCard } from '@/components/chat/TaskCard';
import type { TaskMarker } from '@/lib/task-marker';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

function mk(over: Partial<TaskMarker> = {}): TaskMarker {
  return { id: 't-1', title: 'Fix the tests', state: 'created', kind: 'bug', project: 'ex', ...over };
}

function task(over: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    projectKey: 'ex',
    projectName: 'Ex Chat',
    title: 'Fix the tests',
    goal: 'Make it green.',
    kind: 'bug',
    state: 'awaiting_user_test',
    channelID: 'c-1',
    threadRootID: 'm-1',
    requesterID: 'u-1',
    repos: [
      { path: 'group/sub/repo-a', role: 'primary', branch: 'task/x', mrURL: 'https://git/mr/1' },
      { path: '/', role: 'infra', branch: 'main' },
    ],
    testPlan: { url: 'http://localhost:5173', steps: ['Open the app'], counterSteps: ['Old flow unchanged'], accounts: 'alice/secret', notes: 'Wear a helmet' },
    ...over,
  };
}

function installTask(t: Record<string, unknown> | null, over: { mutate?: (path: string, init?: ApiInit) => Promise<unknown> } = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (!init?.method) return t ? Promise.resolve({ task: t }) : new Promise(() => {});
    return (over.mutate ?? (() => Promise.resolve({})))(path, init);
  });
}

function renderCard(m: TaskMarker = mk(), currentUserId?: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TaskCard marker={m} currentUserId={currentUserId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TaskCard', () => {
  it('paints instantly from the marker while the task loads', () => {
    installTask(null);
    renderCard(mk());
    expect(screen.getByText('Fix the tests')).toBeInTheDocument();
    expect(screen.getByText('ex')).toBeInTheDocument();
    expect(screen.getByTestId('task-state')).toBeInTheDocument();
    expect(screen.queryByTestId('task-goal')).not.toBeInTheDocument();
  });

  it('tones the state and kind chips per value', () => {
    installTask(null);
    const states = ['awaiting_user_test', 'mr_created', 'done', 'setup_failed', 'abandoned', 'created'];
    for (const state of states) {
      const view = renderCard(mk({ state }));
      expect(screen.getByTestId('task-state')).toBeInTheDocument();
      view.unmount();
    }
    for (const kind of ['feature', 'chore', 'bug']) {
      const view = renderCard(mk({ kind }));
      expect(screen.getByTestId('task-card')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('renders goal, repos with MR links, plan links and a linked ticket from live data', async () => {
    installTask(task({ ticket: { connector: 'jira', id: 'EX-12', url: 'https://jira/EX-12' } }));
    // marker state must be awaiting_user_test for the plan to open by default.
    renderCard(mk({ state: 'awaiting_user_test' }), 'u-2'); // not the requester
    expect(await screen.findByTestId('task-goal')).toHaveTextContent('Make it green.');
    expect(screen.getByText('Ex Chat')).toBeInTheDocument();
    expect(screen.getByText('repo-a')).toBeInTheDocument();
    // A degenerate "/" path falls back to the raw path.
    expect(screen.getByText('/')).toBeInTheDocument();
    expect(screen.getByTitle('Merge request for repo-a')).toHaveAttribute('href', 'https://git/mr/1');
    expect(screen.getByTestId('task-ticket')).toHaveAttribute('href', 'https://jira/EX-12');
    // Non-requester title for the open & test link.
    expect(screen.getByTitle(/Served from the requester's machine/)).toBeInTheDocument();
    // Non-requester: no action row.
    expect(screen.queryByTestId('task-signoff')).not.toBeInTheDocument();
    // Plan opens by default in awaiting_user_test.
    expect(screen.getByText('Open the app')).toBeInTheDocument();
    expect(screen.getByText(/1 step\b/)).toBeInTheDocument();
    expect(screen.getByText(/1 must-not check\b/)).toBeInTheDocument();
    expect(screen.getByText('Use: alice/secret')).toBeInTheDocument();
    expect(screen.getByText('Wear a helmet')).toBeInTheDocument();
    expect(screen.getByText('Old flow unchanged')).toBeInTheDocument();
  });

  it('titles a linked ticket with a generic system name when the connector is unknown', async () => {
    installTask(task({ ticket: { connector: '', id: 'EX-14', url: 'https://x/EX-14' } }));
    renderCard(mk(), 'u-2');
    expect(await screen.findByTestId('task-ticket')).toHaveAttribute('title', 'Open EX-14 in the ticket system');
  });

  it('shows an unlinked ticket as a plain chip and folds the plan outside testing states', async () => {
    installTask(
      task({
        state: 'planning',
        ticket: { connector: 'jira', id: 'EX-13' },
        testPlan: { steps: ['a', 'b'], counterSteps: ['x', 'y'] },
      }),
    );
    renderCard(mk({ state: 'planning' }), 'u-2');
    const chip = await screen.findByTestId('task-ticket');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveTextContent('EX-13');
    expect(chip).toHaveAttribute('title', 'Ticket EX-13 (jira)');
    // Folded by default outside awaiting_user_test; plural steps and checks.
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    const toggle = screen.getByText(/2 steps · 2 must-not checks/);
    fireEvent.click(toggle);
    expect(screen.getByText('a')).toBeInTheDocument();
  });

  it('titles an unlinked ticket plainly when no connector is known', async () => {
    installTask(task({ ticket: { connector: '', id: 'EX-15' } }));
    renderCard(mk(), 'u-2');
    expect(await screen.findByTestId('task-ticket')).toHaveAttribute('title', 'Ticket EX-15');
  });

  it('omits the must-not suffix when the plan has no counter-steps', async () => {
    installTask(task({ testPlan: { steps: ['only step'], counterSteps: [] } }));
    renderCard(mk({ state: 'awaiting_user_test' }), 'u-2');
    const toggle = await screen.findByText(/How to test — 1 step/);
    expect(toggle).not.toHaveTextContent('must-not');
  });

  it('keeps the signed-off note singular for a single merge request', async () => {
    installTask(task({ signedOffAt: '2026-09-03T10:00:00Z' }));
    renderCard(mk({ state: 'awaiting_user_test' }), 'u-1');
    expect(await screen.findByText(/Signed off — opening the merge request…/)).toBeInTheDocument();
    expect(screen.queryByText(/merge requests…/)).not.toBeInTheDocument();
  });

  it('folds a long goal behind Show more / Show less', async () => {
    installTask(task({ goal: 'g'.repeat(500) }));
    renderCard(mk(), 'u-2');
    const goal = await screen.findByTestId('task-goal');
    expect(within(goal).getByText('Show more')).toBeInTheDocument();
    fireEvent.click(within(goal).getByText('Show more'));
    expect(within(goal).getByText('Show less')).toBeInTheDocument();
    fireEvent.click(within(goal).getByText('Show less'));
    expect(within(goal).getByText('Show more')).toBeInTheDocument();
  });

  it('lets the requester sign off and shows the in-flight then signed-off states', async () => {
    let release: (v: unknown) => void = () => {};
    const mutate = vi.fn(() => new Promise((res) => { release = res; }));
    installTask(task());
    renderCard(mk({ state: 'awaiting_user_test' }), 'u-1');
    const signoff = await screen.findByTestId('task-signoff');
    // Two repos → plural MRs; requester flavored open & test title.
    expect(signoff).toHaveTextContent('Looks good — create MRs');
    expect(screen.getByTitle(/served from your machine/)).toBeInTheDocument();

    installTask(task(), { mutate });
    fireEvent.click(signoff);
    await waitFor(() => expect(signoff).toBeDisabled());
    expect(mutate).toHaveBeenCalledWith('/api/v1/coding-tasks/t-1/signoff', expect.objectContaining({ method: 'POST' }));
    release({ task: task({ signedOffAt: '2026-09-03T10:00:00Z' }) });
    await waitFor(() => expect(signoff).toBeEnabled());
  });

  it('shows the signed-off waiting note instead of the button once signed off', async () => {
    installTask(
      task({
        signedOffAt: '2026-09-03T10:00:00Z',
        repos: [
          { path: 'a/x', role: 'primary', branch: 'b', mrURL: 'https://git/mr/1' },
          { path: 'a/y', role: 'ui', branch: 'b', mrURL: 'https://git/mr/2' },
        ],
      }),
    );
    renderCard(mk({ state: 'awaiting_user_test' }), 'u-1');
    expect(await screen.findByText(/Signed off — opening the merge requests…/)).toBeInTheDocument();
    expect(screen.queryByTestId('task-signoff')).not.toBeInTheDocument();
  });

  it('closes an mr_created task and hides actions once terminal', async () => {
    const mutate = vi.fn(() => Promise.resolve({}));
    installTask(task({ state: 'mr_created', repos: [task().repos[0] as Record<string, unknown>, { path: 'x/y', role: 'ui', branch: 'b', mrURL: 'https://git/mr/2' }] }), { mutate });
    renderCard(mk({ state: 'mr_created' }), 'u-1');
    const close = await screen.findByTestId('task-close');
    expect(screen.queryByTestId('task-abandon')).not.toBeInTheDocument();
    fireEvent.click(close);
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        '/api/v1/coding-tasks/t-1/close',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ state: 'done' }) }),
      ),
    );

    // Terminal marker state renders no action row at all.
    installTask(task({ state: 'done' }));
    renderCard(mk({ state: 'done' }), 'u-1');
    await waitFor(() => expect(screen.getAllByTestId('task-card').length).toBeGreaterThan(1));
    expect(screen.queryByTestId('task-abandon')).not.toBeInTheDocument();
  });

  it('abandons only after the confirm, and not when the confirm is declined', async () => {
    const mutate = vi.fn(() => Promise.resolve({}));
    installTask(task({ state: 'awaiting_user_test' }), { mutate });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderCard(mk(), 'u-1');
    const abandon = await screen.findByTestId('task-abandon');
    fireEvent.click(abandon);
    expect(mutate).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(abandon);
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        '/api/v1/coding-tasks/t-1/close',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ state: 'abandoned' }) }),
      ),
    );
  });

  it('toggles who may steer and surfaces mutation errors', async () => {
    installTask(task({ steering: 'requester' }), { mutate: () => Promise.reject(new Error('locked')) });
    renderCard(mk(), 'u-1');
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/coding-tasks/t-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ steering: 'anyone' }) }),
      ),
    );
    expect(await screen.findByText('locked')).toBeInTheDocument();
  });

  it('unchecks steering back to requester-only and falls back on message-less errors', async () => {
    installTask(task({ steering: 'anyone' }), { mutate: () => Promise.reject({}) });
    renderCard(mk(), 'u-1');
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/coding-tasks/t-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ steering: 'requester' }) }),
      ),
    );
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  });

  it('saves a successful steering change', async () => {
    const mutate = vi.fn(() => Promise.resolve({ task: task({ steering: 'anyone' }) }));
    installTask(task({ steering: 'requester' }), { mutate });
    renderCard(mk(), 'u-1');
    fireEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('surfaces a close failure from the abandon flow', async () => {
    installTask(task(), { mutate: () => Promise.reject(new Error('busy')) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCard(mk(), 'u-1');
    fireEvent.click(await screen.findByTestId('task-abandon'));
    expect(await screen.findByText('busy')).toBeInTheDocument();
  });

  it('tolerates legacy tasks with null repos and test plans', async () => {
    installTask(task({ repos: null, testPlan: null, goal: '' }));
    renderCard(mk(), 'u-1');
    await screen.findByText('Ex Chat');
    expect(screen.queryByTestId('task-goal')).not.toBeInTheDocument();
    expect(screen.queryByText(/How to test/)).not.toBeInTheDocument();
    // Single repo-less task: sign-off button uses the singular MR label.
    expect(screen.getByTestId('task-signoff')).toHaveTextContent(/create MR$/);
  });
});
