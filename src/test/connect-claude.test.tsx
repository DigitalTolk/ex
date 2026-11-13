import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentsPage from '@/pages/AgentsPage';
import { ApiError } from '@/lib/api';
import type { RunnerInstall, WorkbenchJob } from '@/hooks/useRunnerTokens';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', systemRole: 'member' } }),
}));

const laptop: RunnerInstall = { id: 'rt-1', label: 'laptop', createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' };
const workbench: RunnerInstall = { ...laptop, id: 'rt-2', label: 'Agent workbench', workbench: true };

let runners: RunnerInstall[];
let settings: Record<string, unknown>;
let jobs: Array<WorkbenchJob | Error>; // the status checks' answers, in order; the last repeats
let connect: () => Promise<unknown>;

beforeEach(() => {
  showToast.mockReset();
  runners = [laptop];
  settings = { maxUploadBytes: 0, allowedExtensions: [], workbenchEnabled: true };
  jobs = [{ id: 'job-1', state: 'queued' }];
  connect = async () => {
    runners = [laptop, workbench];
    return { id: 'job-1', state: 'queued' };
  };
  mockApiFetch.mockImplementation(async (path, init) => {
    if (path === '/api/v1/admin/settings') return settings;
    if (path === '/api/v1/agents') return { agents: [] };
    if (path === '/api/v1/runner-tokens') return { runners };
    if (path === '/api/v1/runner-tokens/workbench') {
      if (init?.method === 'POST') return connect();
      const next = jobs.length > 1 ? jobs.shift()! : jobs[0];
      if (next instanceof Error) throw next;
      return next;
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
  });
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentsPage />
    </QueryClientProvider>,
  );
}

const button = () => screen.findByRole('button', { name: 'Connect to Claude' });

describe('Connect to Claude', () => {
  it('connects, follows the setup while it runs, and goes away once it is done', async () => {
    jobs = [
      { id: 'job-1', state: 'queued' },
      { id: 'job-1', state: 'running' },
      { id: 'job-1', state: 'done' },
    ];
    renderPage();
    fireEvent.click(await button());

    expect(await screen.findByText('Waiting for the agent workbench to start setting up your runner.')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/workbench', { method: 'POST' });
    expect(screen.getByTestId('connect-claude')).toHaveAttribute('aria-busy', 'true');
    // Polled every few seconds while queued or running.
    expect(await screen.findByText('The agent workbench is setting up your runner.', undefined, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('connect-claude')).toBeNull(), { timeout: 5000 });
  }, 15000);

  it('shows Connecting while ex hands the runner over', async () => {
    let finish!: () => void;
    connect = () =>
      new Promise((resolve) => {
        finish = () => resolve({ id: 'job-1', state: 'queued' });
      });
    renderPage();
    fireEvent.click(await button());

    const busy = await screen.findByRole('button', { name: 'Connecting…' });
    expect(busy).toBeDisabled();
    finish();
    expect(await button()).toBeEnabled();
  });

  it("says why when the workbench can't take the setup", async () => {
    connect = async () => {
      runners = [laptop, workbench];
      throw new ApiError(424, "the agent workbench couldn't set you up");
    };
    jobs = [{ id: '', state: 'failed' }];
    renderPage();
    fireEvent.click(await button());

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("the agent workbench couldn't set you up"));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `The agent workbench couldn't set you up. To try again, disconnect "Agent workbench" from your runners.`,
    );
  });

  it('falls back to a plain message when the error has none', async () => {
    connect = async () => {
      throw new Error('');
    };
    renderPage();
    fireEvent.click(await button());

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't connect to Claude."));
  });

  it("shows the workbench's own reason for a failed setup", async () => {
    runners = [workbench];
    jobs = [{ id: 'job-1', state: 'failed', status: '  No Pocket ID user found  ' }];
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No Pocket ID user found To try again, disconnect "Agent workbench" from your runners.',
    );
    expect(screen.getByText('Setting up your runner failed')).toBeInTheDocument();
  });

  it('says so when the workbench cannot be asked', async () => {
    runners = [workbench];
    jobs = [new ApiError(424, "couldn't reach the agent workbench")];
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't reach the agent workbench");
  });

  it('is not offered once set up', async () => {
    runners = [workbench];
    jobs = [{ id: 'job-1', state: 'done', status: { ok: true } }];
    renderPage();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/workbench', undefined));
    await screen.findByTestId('agents-empty');
    expect(screen.queryByTestId('connect-claude')).toBeNull();
  });

  it('shows nothing for an empty status answer', async () => {
    runners = [workbench];
    jobs = [undefined as unknown as WorkbenchJob];
    renderPage();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/workbench', undefined));
    await screen.findByTestId('agents-empty');
    expect(screen.queryByTestId('connect-claude')).toBeNull();
  });

  it('is not offered when this server has no workbench', async () => {
    settings = { ...settings, workbenchEnabled: false };
    renderPage();
    await screen.findByTestId('agents-empty');
    expect(screen.queryByTestId('connect-claude')).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/runner-tokens', undefined);
  });
});
