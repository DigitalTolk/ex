import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentsPage from '@/pages/AgentsPage';
import { ApiError } from '@/lib/api';
import type { RunnerInstall, WorkbenchJob } from '@/hooks/useRunnerTokens';
import type { AgentView } from '@/hooks/useAgents';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
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
let agents: AgentView[];
let settings: Record<string, unknown>;
let jobs: Array<WorkbenchJob | Error>; // the status checks' answers, in order; the last repeats
let connect: () => Promise<unknown>;
let revoke: (id: string) => Promise<unknown>;
const online: RunnerInstall = { ...workbench, online: true, harnesses: [{ name: 'claude', authed: true }] };

beforeEach(() => {
  runners = [laptop];
  agents = [];
  settings = { maxUploadBytes: 0, allowedExtensions: [], workbenchEnabled: true };
  jobs = [{ id: 'job-1', state: 'queued' }];
  connect = async () => {
    runners = [laptop, workbench];
    return { id: 'job-1', state: 'queued' };
  };
  revoke = async (id) => {
    runners = runners.filter((r) => r.id !== id);
  };
  mockApiFetch.mockImplementation(async (path, init) => {
    if (path === '/api/v1/admin/settings') return settings;
    if (path === '/api/v1/agents') return { agents };
    if (path === '/api/v1/runner-tokens') return { runners };
    if (path === '/api/v1/runner-tokens/rt-2' && init?.method === 'DELETE') return revoke('rt-2');
    if (path === '/api/v1/runner-tokens/workbench') {
      if (init?.method === 'POST') return connect();
      const next = jobs.length > 1 ? jobs.shift()! : jobs[0];
      if (next instanceof Error) throw next;
      // The runner comes online as the workbench finishes.
      if (next?.state === 'done' && runners.includes(workbench)) runners = [laptop, online];
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

const button = (name = 'Connect to Claude') => screen.findByRole('button', { name });
const card = () => screen.getByTestId('connect-claude');
// The step the setup is on.
const current = () => card().querySelector('[aria-current="step"]');

describe('Connect to Claude', () => {
  it('walks through the setup until the runner is online', async () => {
    jobs = [
      { id: 'job-1', state: 'queued' },
      { id: 'job-1', state: 'running' },
      { id: 'job-1', state: 'done' },
    ];
    renderPage();
    expect(await screen.findByText(/Nothing to install/)).toBeInTheDocument();
    fireEvent.click(await button());

    expect(await screen.findByText('Waiting for the workbench to start')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/workbench', { method: 'POST' });
    expect(card()).toHaveAttribute('aria-busy', 'true');
    expect(current()).toHaveTextContent('Set up your runner');
    expect(screen.getByText('Ask the agent workbench for a runner').closest('li')).toHaveAttribute('data-state', 'done');
    // Checked every few seconds until the runner is online.
    await waitFor(() => expect(screen.queryByText('Waiting for the workbench to start')).toBeNull());
    expect(current()).toHaveTextContent('Set up your runner');

    expect(await screen.findByText('Connected to Claude')).toBeInTheDocument();
    expect(card()).not.toHaveAttribute('aria-busy');
    expect(card()).toHaveTextContent('Agent workbench · Claude Code');
  });

  it('shows the first step while ex asks the workbench', async () => {
    let finish!: () => void;
    connect = () =>
      new Promise((resolve) => {
        finish = () => {
          runners = [laptop, workbench];
          resolve({ id: 'job-1', state: 'queued' });
        };
      });
    renderPage();
    fireEvent.click(await button());

    await waitFor(() => expect(current()).toHaveTextContent('Ask the agent workbench for a runner'));
    expect(screen.getByText('Bring it online').closest('li')).toHaveAttribute('data-state', 'todo');
    expect(screen.queryByRole('button')).toBeNull();
    finish();
    await waitFor(() => expect(current()).toHaveTextContent('Set up your runner'));
  });

  it('waits for the runner to come online, and can start over', async () => {
    runners = [laptop, { ...workbench }];
    jobs = [{ id: 'job-1', state: 'done' }];
    renderPage();

    await waitFor(() => expect(current()).toHaveTextContent('Bring it online'));
    fireEvent.click(await button('Start over'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/rt-2', { method: 'DELETE' }));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/workbench', { method: 'POST' });
  });

  it("gives the workbench's reason for a failed setup, and tries again", async () => {
    runners = [workbench];
    jobs = [{ id: 'job-1', state: 'failed', status: '  No Pocket ID user found  ' }];
    renderPage();

    expect(await screen.findByText("Couldn't connect to Claude")).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/^No Pocket ID user found$/);
    fireEvent.click(await button('Try again'));
    jobs = [{ id: 'job-1', state: 'queued' }];
    expect(await screen.findByText('Waiting for the workbench to start')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/rt-2', { method: 'DELETE' });
  });

  it('says so when trying again goes wrong', async () => {
    runners = [workbench];
    jobs = [{ id: 'job-1', state: 'failed' }];
    revoke = async () => {
      throw new ApiError(500, 'could not disconnect');
    };
    renderPage();

    expect(await screen.findByText("The agent workbench couldn't set up your runner.")).toBeInTheDocument();
    fireEvent.click(await button('Try again'));
    expect(await screen.findByText('could not disconnect')).toBeInTheDocument();
  });

  it('shows a refused setup once, as the failed card', async () => {
    connect = async () => {
      runners = [laptop, workbench];
      throw new ApiError(424, "the agent workbench couldn't set you up");
    };
    jobs = [{ id: '', state: 'failed' }];
    renderPage();
    fireEvent.click(await button());

    expect(await screen.findByText("Couldn't connect to Claude")).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText("the agent workbench couldn't set you up")).toBeNull();
  });

  it('says why when ex could not ask the workbench', async () => {
    connect = async () => {
      throw new Error('');
    };
    renderPage();
    fireEvent.click(await button());

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't connect to Claude.");
    expect(await button()).toBeEnabled();
  });

  it('keeps checking while the workbench cannot be reached', async () => {
    runners = [workbench];
    jobs = [new ApiError(424, "couldn't reach the agent workbench"), { id: 'job-1', state: 'running' }];
    renderPage();

    expect(await screen.findByText(/Can't reach the agent workbench/)).toBeInTheDocument();
    expect(await button('Start over')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Can't reach the agent workbench/)).toBeNull());
    expect(current()).toHaveTextContent('Set up your runner');
  });

  it('follows a setup with no status yet', async () => {
    runners = [workbench];
    jobs = [undefined as unknown as WorkbenchJob];
    renderPage();
    await waitFor(() => expect(current()).toHaveTextContent('Set up your runner'));
  });

  it('shows the online runner in one line, and can disconnect it', async () => {
    runners = [
      laptop,
      { ...online, os: 'linux', version: '0.0.3', harnesses: [{ name: 'claude', version: '2.1.312 (Claude Code)', authed: true }, { name: 'codex', authed: false }] },
    ];
    renderPage();

    expect(await screen.findByText('Connected to Claude')).toBeInTheDocument();
    expect(card()).toHaveTextContent('Online');
    expect(card()).toHaveTextContent('Agent workbench · Linux · ex-runner 0.0.3 · Claude Code 2.1.312 · Codex (not signed in)');
    expect(within(card()).queryByText(/ex-runner login/)).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/runner-tokens/workbench', undefined);

    fireEvent.click(within(card()).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByTestId('workbench-disconnect-confirm')).toHaveTextContent('connect to Claude here');
    fireEvent.click(screen.getByTestId('workbench-disconnect-confirm-confirm'));
    expect(await button()).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/rt-2', { method: 'DELETE' });
  });

  it('says so when disconnecting fails, and a cancel keeps it', async () => {
    runners = [{ ...online, harnesses: undefined }];
    revoke = async () => {
      throw new ApiError(500, 'try later');
    };
    renderPage();

    expect(await screen.findByText('Agent workbench')).toBeInTheDocument();
    fireEvent.click(within(card()).getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(await screen.findByTestId('workbench-disconnect-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('workbench-disconnect-confirm')).toBeNull());
    fireEvent.click(within(card()).getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(await screen.findByTestId('workbench-disconnect-confirm-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't disconnect: try later");
  });

  it('is not offered when this server has no workbench', async () => {
    settings = { ...settings, workbenchEnabled: false };
    renderPage();
    await screen.findByTestId('agents-empty');
    expect(screen.queryByTestId('connect-claude')).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/runner-tokens', undefined);
  });
});

describe('Where an agent is ready', () => {
  const claude = { name: 'claude', authed: true };
  const codex = { name: 'codex', authed: true };
  const agent = (slug: string, harness: string, status: string): AgentView => ({
    id: `ag-${slug}`,
    displayName: slug,
    slug,
    status,
    prefs: { userID: 'u-1', slug },
    resolved: { harness, model: '', persona: '', limits: {}, maxConcurrentRuns: 1 },
  });
  // The card's one-line summary, once the runner list has filled it in.
  const shows = (slug: string, text: string) =>
    waitFor(() => expect(within(screen.getByRole('button', { name: `Configure @${slug}` })).getByText(text)).toBeInTheDocument());

  beforeEach(() => {
    jobs = [{ id: 'job-1', state: 'done' }];
    agents = [agent('gg', 'claude', 'active'), agent('ns', 'codex', 'needs_setup')];
  });

  it('names the agent workbench when that is the only runner online', async () => {
    runners = [laptop, { ...workbench, online: true, harnesses: [claude] }];
    renderPage();
    await shows('gg', 'ready on the agent workbench');
    await shows('ns', 'CLI missing on the agent workbench');
  });

  it('names both when the CLI is on the machine and the workbench', async () => {
    runners = [
      { ...laptop, online: true, harnesses: [claude, codex] },
      { ...workbench, online: true, harnesses: [claude] },
    ];
    agents = [agent('gg', 'claude', 'active')];
    renderPage();
    await shows('gg', 'ready on your machine and the agent workbench');
  });

  it("names only the runners that have the agent's CLI", async () => {
    runners = [
      { ...laptop, online: true, harnesses: [codex] },
      { ...workbench, online: true, harnesses: [claude] },
    ];
    agents = [agent('gg', 'claude', 'active'), agent('cx', 'codex', 'active')];
    renderPage();
    await shows('gg', 'ready on the agent workbench');
    await shows('cx', 'ready on your machine');
  });

  it('stays on your machine for a computer of your own', async () => {
    // A second computer whose runner has not reported its CLIs yet.
    runners = [{ ...laptop, online: true, harnesses: [claude] }, { ...laptop, id: 'rt-3', online: true }];
    renderPage();
    await shows('gg', 'ready on your machine');
    await shows('ns', 'CLI missing on your machine');
  });
});
