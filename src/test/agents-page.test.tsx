import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentsPage from '@/pages/AgentsPage';
import type { AgentView, AgentSubscription } from '@/hooks/useAgents';
import type { UserChannel } from '@/types';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

let mockUser: { id: string; systemRole?: string } | undefined;
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

// gg: everything inherited (empty prefs), active. qib: every pref set, bedrock,
// needs_setup. aa: always-follow-up, offline. ww: window follow-up with mins=0
// (falls back to 10), unknown status, codex resolved model.
function agentFixtures(): AgentView[] {
  return [
    {
      id: 'ag-gg',
      displayName: 'gg',
      slug: 'gg',
      status: 'active',
      prefs: { userID: 'u-1', slug: 'gg' },
      resolved: { harness: 'claude', model: '', persona: 'Default gg persona', limits: {}, maxConcurrentRuns: 1 },
    },
    {
      id: 'ag-qib',
      displayName: 'qib',
      slug: 'qib',
      status: 'needs_setup',
      prefs: {
        userID: 'u-1',
        slug: 'qib',
        persona: 'My qib persona',
        harness: 'bedrock',
        model: 'my-bedrock-model',
        offlinePolicy: 'queue',
        executionMode: 'runner',
        followUpMode: 'window',
        followUpMins: 30,
        followUpAsk: true,
        autoAllow: ['read'],
        limits: { maxChainRounds: 5 },
      },
      resolved: {
        harness: 'bedrock',
        model: 'anthropic.claude-3-5',
        persona: 'Default qib persona',
        limits: { maxChainRounds: 8 },
        maxConcurrentRuns: 2,
      },
    },
    {
      id: 'ag-aa',
      displayName: 'aa',
      slug: 'aa',
      status: 'offline',
      prefs: { userID: 'u-1', slug: 'aa', followUpMode: 'always' },
      resolved: { harness: 'claude', model: '', persona: 'Default aa persona', limits: {}, maxConcurrentRuns: 1 },
    },
    {
      id: 'ag-ww',
      displayName: 'ww',
      slug: 'ww',
      status: 'paused',
      prefs: { userID: 'u-1', slug: 'ww', followUpMode: 'window', followUpMins: 0 },
      resolved: { harness: 'codex', model: 'codex-large', persona: 'Default ww persona', limits: {}, maxConcurrentRuns: 1 },
    },
  ];
}

const ggSubs: AgentSubscription[] = [
  {
    id: 's1',
    agentID: 'ag-gg',
    creatorID: 'u-1',
    parentID: 'ch-1',
    parentType: 'channel',
    keywords: ['deploy', 'alerts'],
    heartbeatMins: 30,
  },
  { id: 's2', agentID: 'ag-gg', creatorID: 'u-1', parentID: 'ch-gone', parentType: 'channel' },
];

const userChannels: UserChannel[] = [
  { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
];

interface Routes {
  agents?: () => Promise<unknown>;
  channels?: () => Promise<unknown>;
  mutate?: (path: string, init?: ApiInit) => Promise<unknown> | undefined;
}

function installRoutes(over: Routes = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (!init?.method) {
      if (path === '/api/v1/agents') {
        return (over.agents ?? (async () => ({ agents: agentFixtures() })))();
      }
      if (path === '/api/v1/channels') {
        return (over.channels ?? (async () => userChannels))();
      }
      const m = path.match(/^\/api\/v1\/agents\/([^/]+)\/subscriptions$/);
      if (m) return Promise.resolve({ subscriptions: m[1] === 'gg' ? ggSubs : [] });
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
      <AgentsPage />
    </QueryClientProvider>,
  );
}

async function findCard(slug: string) {
  return within(await screen.findByTestId(`agent-card-${slug}`));
}

// The Watch button is disabled whenever no channel is chosen, so the
// defensive early-return inside add() can't be reached through a real
// click: both React's event system and base-ui's useButton swallow clicks
// on disabled buttons. Walk up the fiber tree to the outermost component
// that received the raw onClick prop (the ui Button wrapper) and invoke it.
function forceReactClick(el: HTMLElement) {
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  expect(fiberKey).toBeTruthy();
  interface Fiberish {
    return: Fiberish | null;
    type: unknown;
    memoizedProps?: { onClick?: (e: object) => void };
  }
  const start = (el as unknown as Record<string, Fiberish | null>)[fiberKey as string];
  let candidate: Fiberish | null = null;
  for (let f = start; f; f = f.return) {
    if (typeof f.type === 'function' && typeof f.memoizedProps?.onClick === 'function') {
      candidate = f;
    }
  }
  expect(candidate).toBeTruthy();
  act(() => {
    candidate!.memoizedProps!.onClick!({ preventDefault() {}, stopPropagation() {} });
  });
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockUser = { id: 'u-1', systemRole: 'admin' };
});

describe('AgentsPage', () => {
  it('shows loading skeletons while agents load', () => {
    installRoutes({ agents: () => new Promise(() => {}) });
    renderPage();
    expect(screen.getByTestId('agents-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('agents-empty')).not.toBeInTheDocument();
  });

  it('shows the empty state when the agents query errors', async () => {
    installRoutes({ agents: () => Promise.reject(new Error('boom')) });
    renderPage();
    expect(await screen.findByTestId('agents-empty')).toBeInTheDocument();
  });

  it('shows the empty state when the server returns no payload', async () => {
    installRoutes({ agents: async () => undefined });
    renderPage();
    expect(await screen.findByTestId('agents-empty')).toBeInTheDocument();
  });

  it('renders every agent with status badge, resolved config, and watched channels; hides admin form for non-admins', async () => {
    mockUser = undefined;
    const chans = deferred<UserChannel[]>();
    installRoutes({ channels: () => chans.promise });
    renderPage();

    const gg = await findCard('gg');
    expect(screen.queryByRole('button', { name: 'New agent' })).not.toBeInTheDocument();

    expect(gg.getByText('ready on your machine')).toBeInTheDocument();
    expect(gg.getByText('for you: claude')).toBeInTheDocument();
    expect(gg.getByLabelText('Model')).toHaveAttribute('placeholder', 'harness default');
    expect(gg.getByLabelText('Discussion rounds')).toHaveAttribute('placeholder', '12');
    expect(gg.getByLabelText('Thread follow-ups')).toHaveValue('');
    expect(gg.queryByLabelText('ask me before it replies')).not.toBeInTheDocument();

    const qib = await findCard('qib');
    expect(qib.getByText('CLI missing on your machine')).toBeInTheDocument();
    expect(qib.getByText('for you: bedrock · anthropic.claude-3-5')).toBeInTheDocument();
    expect(qib.getByLabelText('Model')).toHaveAttribute('placeholder', 'anthropic.claude-3-5');
    expect(qib.getByLabelText('Discussion rounds')).toHaveValue(5);
    expect(qib.getByLabelText('Discussion rounds')).toHaveAttribute('placeholder', '8');
    expect(qib.getByLabelText('Runs on')).toHaveValue('runner');
    expect(qib.getByLabelText('Thread follow-ups')).toHaveValue('window:30');
    expect(qib.getByLabelText('ask me before it replies')).toBeChecked();
    expect(qib.getByLabelText('Read files')).toBeChecked();
    expect(qib.getByText(/Runs via AWS Bedrock/)).toBeInTheDocument();

    const aa = await findCard('aa');
    expect(aa.getByText('desktop app not running')).toBeInTheDocument();
    expect(aa.getByLabelText('Thread follow-ups')).toHaveValue('always');

    const ww = await findCard('ww');
    expect(ww.getByText('paused')).toBeInTheDocument();
    expect(ww.getByLabelText('Thread follow-ups')).toHaveValue('window:10');
    expect(ww.getByLabelText('Model')).toHaveAttribute('placeholder', 'codex-large');

    // Subscriptions render before the channels list resolves: parentID is the
    // fallback name until the lookup succeeds.
    const s1 = within(await screen.findByTestId('agent-sub-s1'));
    expect(s1.getByText('~ch-1')).toBeInTheDocument();
    expect(s1.getByText('keywords: deploy, alerts · check-in every 30m')).toBeInTheDocument();
    const s2 = within(screen.getByTestId('agent-sub-s2'));
    expect(s2.getByText('all messages')).toBeInTheDocument();

    chans.resolve(userChannels);
    await waitFor(() => expect(s1.getByText('~general')).toBeInTheDocument());
    expect(s2.getByText('~ch-gone')).toBeInTheDocument();
  });

  it('lets an admin create an agent, keeping bedrock fields and surfacing failures', async () => {
    let createResult: () => Promise<unknown> = async () => ({});
    installRoutes({
      mutate: (path, init) =>
        path === '/api/v1/agents' && init?.method === 'POST' ? createResult() : undefined,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New agent' }));
    const form = within(screen.getByTestId('new-agent-form'));
    expect(form.getByLabelText('Display name')).toHaveAttribute('placeholder', 'Researcher');

    const createBtn = form.getByRole('button', { name: 'Create agent' });
    expect(createBtn).toBeDisabled();
    fireEvent.change(form.getByLabelText('Handle'), { target: { value: 'RES-1' } });
    expect(form.getByLabelText('Handle')).toHaveValue('res-1');
    expect(form.getByLabelText('Display name')).toHaveAttribute('placeholder', 'res-1');
    expect(createBtn).toBeDisabled();
    fireEvent.change(form.getByLabelText('Display name'), { target: { value: 'Res' } });
    fireEvent.change(form.getByLabelText('Prompt (persona)'), { target: { value: 'Be helpful.' } });
    expect(createBtn).toBeEnabled();

    expect(form.queryByLabelText('Runs on')).not.toBeInTheDocument();
    fireEvent.change(form.getByLabelText('Backend'), { target: { value: 'bedrock' } });
    fireEvent.change(form.getByLabelText('Runs on'), { target: { value: 'server' } });
    fireEvent.change(form.getByLabelText('Model'), { target: { value: 'bed-model' } });

    createResult = () => Promise.reject(new Error('slug taken'));
    fireEvent.click(createBtn);
    expect(await screen.findByText('Create failed: slug taken.')).toBeInTheDocument();

    fireEvent.change(form.getByLabelText('Backend'), { target: { value: 'claude' } });
    createResult = async () => ({});
    fireEvent.click(createBtn);
    await waitFor(() => expect(screen.queryByTestId('new-agent-form')).not.toBeInTheDocument());

    const posts = mockApiFetch.mock.calls.filter(
      ([p, i]) => p === '/api/v1/agents' && i?.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0][1]!.body!)).toMatchObject({ harness: 'bedrock', executionMode: 'server' });
    expect(JSON.parse(posts[1][1]!.body!)).toEqual({
      slug: 'res-1',
      displayName: 'Res',
      harness: 'claude',
      model: 'bed-model',
      executionMode: '',
      persona: 'Be helpful.',
    });
  });

  it('shows create pending state, a plain failure message, and closes on cancel', async () => {
    const d = deferred<unknown>();
    installRoutes({
      mutate: (path, init) =>
        path === '/api/v1/agents' && init?.method === 'POST' ? d.promise : undefined,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New agent' }));
    const form = within(screen.getByTestId('new-agent-form'));
    fireEvent.change(form.getByLabelText('Handle'), { target: { value: 'aid' } });
    fireEvent.change(form.getByLabelText('Prompt (persona)'), { target: { value: 'p' } });
    fireEvent.click(form.getByRole('button', { name: 'Create agent' }));
    expect(await form.findByText('Creating…')).toBeInTheDocument();

    d.reject('nope');
    expect(await screen.findByText('Create failed.')).toBeInTheDocument();

    fireEvent.click(form.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('new-agent-form')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeInTheDocument();
  });

  it('saves inherited-default prefs with the pending → saved → save cycle', async () => {
    const patch = deferred<unknown>();
    let patchBody: unknown;
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/agents/gg/prefs' && init?.method === 'PATCH') {
          patchBody = JSON.parse(init.body!);
          return patch.promise;
        }
        return undefined;
      },
    });
    renderPage();

    const gg = await findCard('gg');
    expect(gg.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(gg.getByLabelText('Your prompt for @gg'), { target: { value: 'custom prompt' } });
    // Check two auto-allow classes, then untick one again.
    fireEvent.click(gg.getByLabelText('Read files'));
    fireEvent.click(gg.getByLabelText('Edit & write files'));
    fireEvent.click(gg.getByLabelText('Edit & write files'));

    const saveBtn = gg.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeEnabled();
    fireEvent.click(saveBtn);
    expect(await gg.findByRole('button', { name: 'Saving…' })).toBeDisabled();

    patch.resolve(agentFixtures()[0]);
    expect(await gg.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
    // The saved flash resets after 2s.
    await waitFor(() => expect(gg.getByRole('button', { name: 'Save' })).toBeInTheDocument(), {
      timeout: 3500,
    });

    expect(patchBody).toEqual({
      persona: 'custom prompt',
      harness: '',
      model: '',
      executionMode: '',
      offlinePolicy: '',
      followUpMode: '',
      followUpMins: 0,
      followUpAsk: false,
      autoAllow: ['read'],
      limits: {},
    });
  });

  it('saves fully-set bedrock prefs (window follow-up, chain rounds, auto-allow)', async () => {
    let patchBody: unknown;
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/agents/qib/prefs' && init?.method === 'PATCH') {
          patchBody = JSON.parse(init.body!);
          return Promise.resolve({});
        }
        return undefined;
      },
    });
    renderPage();

    const qib = await findCard('qib');
    fireEvent.change(qib.getByLabelText('Model'), { target: { value: 'new-model' } });
    fireEvent.click(qib.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(patchBody).toEqual({
        persona: 'My qib persona',
        harness: 'bedrock',
        model: 'new-model',
        executionMode: 'runner',
        offlinePolicy: 'queue',
        followUpMode: 'window',
        followUpMins: 30,
        followUpAsk: true,
        autoAllow: ['read'],
        limits: { maxChainRounds: 5 },
      }),
    );
  });

  it('saves offline policy, chain rounds, and an always follow-up', async () => {
    let patchBody: unknown;
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/agents/aa/prefs' && init?.method === 'PATCH') {
          patchBody = JSON.parse(init.body!);
          return Promise.resolve({});
        }
        return undefined;
      },
    });
    renderPage();

    const aa = await findCard('aa');
    fireEvent.change(aa.getByLabelText('If your app is offline'), { target: { value: 'queue' } });
    fireEvent.change(aa.getByLabelText('Discussion rounds'), { target: { value: '3' } });
    fireEvent.click(aa.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(patchBody).toEqual({
        persona: '',
        harness: '',
        model: '',
        executionMode: '',
        offlinePolicy: 'queue',
        followUpMode: 'always',
        followUpMins: 0,
        followUpAsk: false,
        autoAllow: [],
        limits: { maxChainRounds: 3 },
      }),
    );
  });

  it('switching a default card to bedrock reveals the runner controls', async () => {
    installRoutes();
    renderPage();

    const gg = await findCard('gg');
    expect(gg.queryByLabelText('Runs on')).not.toBeInTheDocument();
    fireEvent.change(gg.getByLabelText('Backend'), { target: { value: 'bedrock' } });
    expect(gg.getByLabelText('Model')).toHaveAttribute(
      'placeholder',
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
    );
    const exec = gg.getByLabelText('Runs on');
    expect(exec).toHaveValue('runner');
    fireEvent.change(exec, { target: { value: 'server' } });
    expect(exec).toHaveValue('server');
    expect(gg.getByText(/Runs via AWS Bedrock/)).toBeInTheDocument();
  });

  it('shows the follow-up ask checkbox once a window is chosen', async () => {
    installRoutes();
    renderPage();

    const gg = await findCard('gg');
    fireEvent.change(gg.getByLabelText('Thread follow-ups'), { target: { value: 'window:10' } });
    const ask = gg.getByLabelText('ask me before it replies');
    fireEvent.click(ask);
    expect(ask).toBeChecked();
  });

  it('surfaces save failures with and without an Error message', async () => {
    let failure: unknown = 'x';
    installRoutes({
      mutate: (path, init) =>
        path === '/api/v1/agents/ww/prefs' && init?.method === 'PATCH'
          ? Promise.reject(failure)
          : undefined,
    });
    renderPage();

    const ww = await findCard('ww');
    fireEvent.change(ww.getByLabelText('Thread follow-ups'), { target: { value: 'window:60' } });
    fireEvent.click(ww.getByRole('button', { name: 'Save' }));
    expect(await ww.findByText('Save failed.')).toBeInTheDocument();

    failure = new Error('server said no');
    fireEvent.click(ww.getByRole('button', { name: 'Save' }));
    expect(await ww.findByText('Save failed: server said no.')).toBeInTheDocument();
  });

  it('adds and removes watched channels, guarding the empty-channel add', async () => {
    const posts: unknown[] = [];
    const deletes: string[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/agents/gg/subscriptions' && init?.method === 'POST') {
          posts.push(JSON.parse(init.body!));
          return Promise.resolve({});
        }
        if (init?.method === 'DELETE') {
          deletes.push(path);
          return Promise.resolve({});
        }
        return undefined;
      },
    });
    renderPage();

    const gg = await findCard('gg');
    await gg.findByTestId('agent-sub-s1');

    const watchBtn = () => gg.getByRole('button', { name: 'Watch' });
    expect(watchBtn()).toBeDisabled();
    forceReactClick(watchBtn());
    expect(posts).toHaveLength(0);

    fireEvent.change(gg.getByLabelText('Channel to watch'), { target: { value: 'ch-1' } });
    fireEvent.change(gg.getByPlaceholderText('keywords, comma-separated'), {
      target: { value: 'deploy, ,alerts' },
    });
    fireEvent.change(gg.getByLabelText('Check-in interval'), { target: { value: '30' } });
    expect(watchBtn()).toBeEnabled();
    fireEvent.click(watchBtn());

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      parentID: 'ch-1',
      parentType: 'channel',
      keywords: ['deploy', 'alerts'],
      heartbeatMins: 30,
    });
    // Inputs reset once the subscription is created.
    await waitFor(() => expect(gg.getByLabelText('Channel to watch')).toHaveValue(''));
    expect(gg.getByPlaceholderText('keywords, comma-separated')).toHaveValue('');
    expect(gg.getByLabelText('Check-in interval')).toHaveValue('0');

    fireEvent.change(gg.getByLabelText('Channel to watch'), { target: { value: 'ch-1' } });
    fireEvent.click(watchBtn());
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ parentID: 'ch-1', parentType: 'channel', keywords: [], heartbeatMins: 0 });

    fireEvent.click(within(screen.getByTestId('agent-sub-s1')).getByRole('button', { name: 'Stop watching' }));
    await waitFor(() => expect(deletes).toContain('/api/v1/agents/gg/subscriptions/ch-1/s1'));
  });
});
