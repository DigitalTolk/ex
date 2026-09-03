import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WatcherCatchUpCard } from '@/components/chat/WatcherCatchUpCard';
import type { AgentSubscription } from '@/hooks/useAgents';

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

function watcher(over: Partial<AgentSubscription> = {}): AgentSubscription {
  return {
    id: 'w-1',
    agentID: 'ag-1',
    creatorID: 'u-1',
    parentID: 'c-1',
    parentType: 'channel',
    pendingCatchUp: true,
    pendingOffline: true,
    pendingSince: '2026-09-03T08:00:00Z',
    instruction: 'watch the deploys',
    ...over,
  };
}

const agentsFixture = [
  {
    id: 'ag-1',
    displayName: 'gg',
    slug: 'gg',
    status: 'active',
    prefs: { userID: 'u-1', slug: 'gg' },
    resolved: { harness: 'claude', model: 'm', persona: '', limits: {}, maxConcurrentRuns: 1 },
  },
];

interface Routes {
  watchers?: () => Promise<unknown>;
  catchup?: (path: string, init?: ApiInit) => Promise<unknown>;
}

function installRoutes(list: AgentSubscription[], over: Routes = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (!init?.method && /\/api\/v1\/(channels|conversations)\/[^/]+\/watchers$/.test(path)) {
      return (over.watchers ?? (async () => ({ watchers: list })))();
    }
    if (!init?.method && path === '/api/v1/agents') {
      return Promise.resolve({ agents: agentsFixture });
    }
    if (init?.method === 'POST' && path.includes('/catchup')) {
      return (over.catchup ?? (() => Promise.resolve({})))(path, init);
    }
    return Promise.resolve({});
  });
}

function renderCard(parentID?: string, parentType: 'channel' | 'conversation' = 'channel') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <WatcherCatchUpCard parentID={parentID} parentType={parentType} />
    </QueryClientProvider>,
  );
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

beforeEach(() => {
  mockApiFetch.mockReset();
  mockUser = { id: 'u-1' };
});

describe('WatcherCatchUpCard', () => {
  it('renders nothing without a parentID', () => {
    installRoutes([watcher()]);
    renderCard(undefined);
    expect(screen.queryByTestId('watcher-catchup-card')).not.toBeInTheDocument();
  });

  it('renders nothing when no watcher of mine has an offline backlog', async () => {
    installRoutes([
      watcher({ id: 'w-other', creatorID: 'u-2' }),
      watcher({ id: 'w-nocatch', pendingCatchUp: false }),
      watcher({ id: 'w-online', pendingOffline: false }),
    ]);
    renderCard('c-1');
    // Give the query a chance to resolve, then confirm nothing rendered.
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('watcher-catchup-card')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no signed-in user', async () => {
    mockUser = undefined;
    installRoutes([watcher()]);
    renderCard('c-1');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('watcher-catchup-card')).not.toBeInTheDocument();
  });

  it('shows the agent name, backlog age and standing order', async () => {
    installRoutes([watcher()]);
    renderCard('c-1');
    const card = await screen.findByTestId('watcher-catchup-card');
    expect(within(card).getByText('gg')).toBeInTheDocument();
    expect(within(card).getByText(/standing order:/)).toBeInTheDocument();
    expect(within(card).getByText(/watch the deploys/)).toBeInTheDocument();
    expect(within(card).getByText(/Messages arrived .* while you were\s+away/)).toBeInTheDocument();
  });

  it('falls back to "A watcher" and omits age/instruction when absent', async () => {
    installRoutes([
      watcher({ id: 'w-a', agentID: 'ag-unknown', pendingSince: undefined, instruction: undefined }),
      watcher({ id: 'w-b' }),
    ]);
    renderCard('c-1');
    const cards = await screen.findAllByTestId('watcher-catchup-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('A watcher')).toBeInTheDocument();
    expect(within(cards[0]).getByText(/Messages arrived while you were\s+away\./)).toBeInTheDocument();
    expect(within(cards[0]).queryByText(/standing order:/)).not.toBeInTheDocument();
  });

  it('processes the backlog, disabling both buttons while in flight', async () => {
    const gate = deferred<unknown>();
    const catchup = vi.fn(() => gate.promise);
    installRoutes([watcher()], { catchup });
    renderCard('c-1');
    const card = await screen.findByTestId('watcher-catchup-card');

    fireEvent.click(within(card).getByTestId('catchup-process'));
    await waitFor(() =>
      expect(catchup).toHaveBeenCalledWith(
        '/api/v1/watchers/c-1/w-1/catchup',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ process: true }) }),
      ),
    );
    await waitFor(() => expect(within(card).getByTestId('catchup-process')).toBeDisabled());
    expect(within(card).getByTestId('catchup-dismiss')).toBeDisabled();

    gate.resolve({});
    await waitFor(() => expect(within(card).getByTestId('catchup-process')).toBeEnabled());
  });

  it('dismisses the backlog and re-enables after a failure', async () => {
    const catchup = vi.fn(() => Promise.reject(new Error('boom')));
    installRoutes([watcher()], { catchup });
    renderCard('c-1');
    const card = await screen.findByTestId('watcher-catchup-card');

    fireEvent.click(within(card).getByTestId('catchup-dismiss'));
    await waitFor(() =>
      expect(catchup).toHaveBeenCalledWith(
        '/api/v1/watchers/c-1/w-1/catchup',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ process: false }) }),
      ),
    );
    // onSettled clears the busy flag even on error.
    await waitFor(() => expect(within(card).getByTestId('catchup-dismiss')).toBeEnabled());
  });

  it('reads watchers from the conversations endpoint for DM parents', async () => {
    installRoutes([watcher({ parentType: 'conversation', parentID: 'v-1' })]);
    renderCard('v-1', 'conversation');
    await screen.findByTestId('watcher-catchup-card');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/conversations/v-1/watchers', undefined);
  });
});
