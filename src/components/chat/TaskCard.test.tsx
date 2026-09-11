import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { TaskCard } from './TaskCard';

const marker = { id: 'T1', title: 'Fix Feb-29 crash', state: 'awaiting_user_test', kind: 'bug', project: 'CliffHub' };

function renderCard(currentUserId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TaskCard marker={marker} currentUserId={currentUserId} />
    </QueryClientProvider>,
  );
}

describe('TaskCard', () => {
  it('renders a legacy task (null repos / test plan) without crashing', async () => {
    apiFetch.mockResolvedValueOnce({
      task: {
        id: 'T1', projectKey: '', projectName: '', title: 'Fix Feb-29 crash', goal: 'g', kind: 'bug',
        state: 'awaiting_user_test', channelID: 'c', threadRootID: 'm', requesterID: 'u-alice',
        repos: null, testPlan: null, signedOffAt: null,
      },
    });
    renderCard('u-alice');
    expect(screen.getByText('Fix Feb-29 crash')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('task-goal')).toHaveTextContent('g'));
    // The requester still gets the sign-off action; no repo chips, no plan.
    await waitFor(() => expect(screen.getByTestId('task-signoff')).toBeInTheDocument());
    expect(screen.queryByText(/How to test/)).toBeNull();
    // Marker fallbacks paint the header before/without task details.
    expect(screen.getByText('CliffHub')).toBeInTheDocument();
    expect(screen.getByTestId('task-state')).toHaveTextContent('ready to test');
  });

  it('lets the requester close a shipped task, or abandon one in flight', async () => {
    const base = {
      id: 'T1', projectKey: 'cliffhub', projectName: 'CliffHub', title: 'Fix Feb-29 crash', goal: 'g', kind: 'bug',
      channelID: 'c', threadRootID: 'm', requesterID: 'u-alice', steering: 'requester', repos: [],
    };
    apiFetch.mockResolvedValue({ task: { ...base, state: 'mr_created' } });
    const shipped = renderCard('u-alice');
    await waitFor(() => expect(screen.getByTestId('task-close')).toBeInTheDocument());
    expect(screen.queryByTestId('task-abandon')).toBeNull();
    await userEvent.click(screen.getByTestId('task-close'));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/v1/coding-tasks/T1/close',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ state: 'done' }) }),
      ),
    );
    shipped.unmount();
    apiFetch.mockResolvedValue({ task: { ...base, state: 'in_progress' } });
    renderCard('u-alice');
    await waitFor(() => expect(screen.getByTestId('task-abandon')).toBeInTheDocument());
    expect(screen.queryByTestId('task-close')).toBeNull();
    apiFetch.mockReset();
  });

  it('shows repos, per-repo MR links and the test plan', async () => {
    apiFetch.mockResolvedValueOnce({
      task: {
        id: 'T1', projectKey: 'cliffhub', projectName: 'CliffHub', title: 'Fix Feb-29 crash', goal: 'g', kind: 'bug',
        state: 'mr_created', channelID: 'c', threadRootID: 'm', requesterID: 'u-alice', steering: 'requester',
        repos: [
          { path: 'dtolk/internal-tools/cliffhub-2-backend', role: 'backend', branch: 'ex/task-1', mrURL: 'https://gitlab/x/-/merge_requests/1' },
          { path: 'dtolk/internal-tools/cliffhub-2-frontend', role: 'frontend', branch: 'ex/task-1' },
        ],
        ticket: { connector: 'cliffhub', id: 'CS-7', url: 'https://cliffhub-stg.digitaltolk.net/tasks/CS-7' },
        testPlan: {
          url: 'http://localhost:3000/leaves',
          steps: ['Sign in as hr1 and open Leaves', 'Tick include pending'],
          counterSteps: ['ica1 must see "Time off" instead of sick leave'],
          accounts: 'hr1@test.com, ica1@test.com',
        },
        signedOffAt: '2026-08-27T10:00:00Z',
      },
    });
    renderCard('u-bob');
    await waitFor(() => expect(screen.getByText('cliffhub-2-backend')).toBeInTheDocument());
    expect(screen.getByText('cliffhub-2-frontend')).toBeInTheDocument();
    expect(screen.getByTitle('Merge request for cliffhub-2-backend')).toHaveAttribute('href', 'https://gitlab/x/-/merge_requests/1');
    expect(screen.getByText('open & test')).toHaveAttribute('href', 'http://localhost:3000/leaves');
    expect(screen.getByTestId('task-ticket')).toHaveAttribute('href', 'https://cliffhub-stg.digitaltolk.net/tasks/CS-7');
    expect(screen.getByTestId('task-ticket')).toHaveTextContent('CS-7');
    // Non-requester: no sign-off, but the plan is readable. The marker says
    // awaiting_user_test, so the plan starts OPEN; the toggle folds it.
    expect(screen.queryByTestId('task-signoff')).toBeNull();
    expect(screen.getByText('Sign in as hr1 and open Leaves')).toBeInTheDocument();
    await userEvent.click(screen.getByText(/How to test — 2 steps/));
    expect(screen.queryByText('Sign in as hr1 and open Leaves')).toBeNull();
    await userEvent.click(screen.getByText(/How to test — 2 steps/));
    expect(screen.getByText('Sign in as hr1 and open Leaves')).toBeInTheDocument();
    expect(screen.getByText(/ica1 must see/)).toBeInTheDocument();
    expect(screen.getByText(/hr1@test.com/)).toBeInTheDocument();
  });
});
