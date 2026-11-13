import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentsPage from '@/pages/AgentsPage';
import { ApiError } from '@/lib/api';
import type { RunnerInstall } from '@/hooks/useRunnerTokens';

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
let connect: () => Promise<unknown>;

beforeEach(() => {
  runners = [laptop];
  settings = { maxUploadBytes: 0, allowedExtensions: [], workbenchEnabled: true };
  connect = async () => {
    runners = [laptop, workbench];
    return undefined;
  };
  mockApiFetch.mockImplementation(async (path, init) => {
    if (path === '/api/v1/admin/settings') return settings;
    if (path === '/api/v1/agents') return { agents: [] };
    if (path === '/api/v1/runner-tokens') return { runners };
    if (path === '/api/v1/runner-tokens/workbench' && init?.method === 'POST') return connect();
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
  it('connects, confirms, and goes away once the workbench runner is listed', async () => {
    renderPage();
    fireEvent.click(await button());

    await waitFor(() => expect(screen.queryByTestId('connect-claude')).toBeNull());
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/workbench', { method: 'POST' });
    expect(showToast).toHaveBeenCalledWith('Connected to Claude. Your agents can run on the agent workbench now.', 'success');
  });

  it('shows Connecting while the workbench sets up', async () => {
    let finish!: () => void;
    connect = () =>
      new Promise((resolve) => {
        finish = () => resolve(undefined);
      });
    renderPage();
    fireEvent.click(await button());

    const busy = await screen.findByRole('button', { name: 'Connecting…' });
    expect(busy).toBeDisabled();
    finish();
    expect(await button()).toBeEnabled();
  });

  it("says why when the workbench can't set them up", async () => {
    connect = async () => {
      throw new ApiError(424, "the agent workbench couldn't set you up");
    };
    renderPage();
    fireEvent.click(await button());

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("the agent workbench couldn't set you up"));
    expect(await button()).toBeEnabled();
  });

  it('falls back to a plain message when the error has none', async () => {
    connect = async () => {
      throw new Error('');
    };
    renderPage();
    fireEvent.click(await button());

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't connect to Claude."));
  });

  it('is not offered once connected', async () => {
    runners = [workbench];
    renderPage();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens', undefined));
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
