import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SchedulesPage from '@/pages/SchedulesPage';
import { ApiError } from '@/lib/api';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

// Two agents so the page proves it gathers orders ACROSS agents — the whole
// reason the page exists, versus expanding each agent card in turn.
const agents = [
  {
    id: 'ag-gg',
    slug: 'gg',
    displayName: 'gg',
    status: 'active',
    prefs: { userID: 'u-1', slug: 'gg' },
    resolved: { harness: 'claude', model: '', persona: 'p', limits: {}, maxConcurrentRuns: 1 },
  },
  {
    id: 'ag-qib',
    slug: 'qib',
    displayName: 'qib',
    status: 'active',
    prefs: { userID: 'u-1', slug: 'qib' },
    resolved: { harness: 'bedrock', model: '', persona: 'p', limits: {}, maxConcurrentRuns: 1 },
  },
];

const subsBySlug: Record<string, unknown[]> = {
  gg: [
    // A plain watcher: must NOT appear on a page about schedules.
    { id: 'w1', agentID: 'ag-gg', creatorID: 'u-1', parentID: 'ch-1', parentType: 'channel', keywords: ['deploy'] },
    {
      id: 's-gg',
      agentID: 'ag-gg',
      creatorID: 'u-1',
      parentID: 'ch-1',
      parentType: 'channel',
      schedule: '0 8 * * 1-5',
      scheduleTZ: 'Europe/Stockholm',
      instruction: "Post yesterday's revenue.",
    },
  ],
  qib: [
    {
      id: 's-qib',
      agentID: 'ag-qib',
      creatorID: 'u-1',
      parentID: 'ch-1',
      parentType: 'channel',
      schedule: '30 17 * * *',
      scheduleTZ: 'UTC',
      instruction: 'Summarise the day.',
    },
  ],
};

interface Routes {
  agents?: () => Promise<unknown>;
  subs?: Record<string, unknown[]>;
  // Leaves channels/connectors/skills pending, so the form can be exercised
  // in its still-loading state.
  slowLists?: boolean;
  mutate?: (path: string, init?: ApiInit) => Promise<unknown> | undefined;
}

function installRoutes(over: Routes = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (!init?.method) {
      if (
        over.slowLists &&
        (path === '/api/v1/channels' || path === '/api/v1/connectors' || path === '/api/v1/skills')
      ) {
        return new Promise(() => {});
      }
      if (path === '/api/v1/agents') return (over.agents ?? (async () => ({ agents })))();
      if (path === '/api/v1/channels') {
        return Promise.resolve([
          { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
        ]);
      }
      if (path === '/api/v1/connectors') {
        return Promise.resolve({
          connectors: [
            { slug: 'metabase', title: 'Metabase', installed: true },
            { slug: 'gitlab', title: 'GitLab', installed: false },
          ],
        });
      }
      if (path.startsWith('/api/v1/users?q=')) {
        // Server-side search: only MATCHES come back, never the full roster.
        const q = decodeURIComponent(path.split('q=')[1] ?? '').toLowerCase();
        const roster = [
          { id: 'u-1', email: 'me@example.com', displayName: 'Manisha Me' },
          { id: 'u-2', email: 'manisha@example.com', displayName: 'Manisha' },
          // Agent users carry no email — they must not appear as recipients.
          { id: 'ag-gg', email: '', displayName: 'Manisha-bot' },
        ];
        return Promise.resolve(roster.filter((u) => u.displayName.toLowerCase().includes(q)));
      }
      if (path === '/api/v1/skills') {
        return Promise.resolve({ skills: [{ id: 'sk-1', name: 'release-notes', description: 'd', instructions: 'i', createdBy: 'u-2', createdAt: '', updatedAt: '' }] });
      }
      const m = path.match(/^\/api\/v1\/agents\/([^/]+)\/subscriptions$/);
      if (m) return Promise.resolve({ subscriptions: (over.subs ?? subsBySlug)[m[1]] ?? [] });
    }
    return over.mutate?.(path, init) ?? Promise.resolve({});
  });
}

// Option queries are scoped to the picker's listbox: the form's timezone
// <select> holds ~420 options, and a form-wide role query over them outlasted
// findBy's timeout on a loaded CI runner.
const destinations = (form: ReturnType<typeof within>) => within(form.getByTestId('destination-options'));

// The destination is a searchable combobox: open it, optionally type, then
// pick. A <select> would not scale to a real workspace's roster.
async function pickDestination(form: ReturnType<typeof within>, optionName: string | RegExp, query?: string) {
  fireEvent.click(form.getByRole('button', { name: 'Where the result goes' }));
  if (query !== undefined) {
    fireEvent.change(form.getByLabelText('Where the result goes'), { target: { value: query } });
  }
  fireEvent.click(await destinations(form).findByRole('option', { name: optionName }));
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SchedulesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  showToast.mockReset();
});

describe('SchedulesPage', () => {
  it('gathers every agent’s schedules into one list, and leaves watchers out', async () => {
    installRoutes();
    renderPage();

    const gg = await screen.findByTestId('schedule-row-s-gg');
    expect(gg).toHaveTextContent('every weekday at 08:00 (Europe/Stockholm)');
    expect(gg).toHaveTextContent('@gg');
    expect(gg).toHaveTextContent('~general');
    expect(gg).toHaveTextContent("Post yesterday's revenue.");

    const qib = screen.getByTestId('schedule-row-s-qib');
    expect(qib).toHaveTextContent('every day at 17:30 (UTC)');
    expect(qib).toHaveTextContent('@qib');

    // The watcher row is not a schedule.
    expect(screen.queryByTestId('schedule-row-w1')).not.toBeInTheDocument();
  });

  it('flags the CLI agent as desk-dependent and leaves the cloud one alone', async () => {
    installRoutes();
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    // gg runs on the claude CLI; qib is bedrock (cloud).
    expect(screen.getByTestId('schedule-row-cli-s-gg')).toHaveTextContent('needs your ex-runner running');
    expect(screen.queryByTestId('schedule-row-cli-s-qib')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing is scheduled', async () => {
    installRoutes({ subs: { gg: [], qib: [] } });
    renderPage();
    expect(await screen.findByTestId('schedules-empty')).toBeInTheDocument();
  });

  it('creates a schedule for a chosen agent, sending cron + timezone', async () => {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'POST') {
          posts.push({ path, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
        }
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');

    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    // The agent picker only exists on this page (the card fixes its agent).
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'qib' } });
    await pickDestination(form, '~general');
    fireEvent.change(form.getByLabelText('Repeats'), { target: { value: 'daily' } });
    fireEvent.change(form.getByLabelText('At'), { target: { value: '06:15' } });
    // The zone defaults to the viewer's but can be changed per order.
    fireEvent.change(form.getByLabelText('Timezone'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.change(form.getByLabelText('What should it do?'), {
      target: { value: 'Daily standup digest.' },
    });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // Posted to the CHOSEN agent, not the first one.
    expect(posts[0].path).toBe('/api/v1/agents/qib/subscriptions');
    // A channel destination posts there, so the action mode allows it.
    expect(posts[0].body).toMatchObject({
      parentID: 'ch-1',
      parentType: 'channel',
      schedule: '15 6 * * *',
      scheduleTZ: 'Asia/Tokyo',
      instruction: 'Daily standup digest.',
      actionMode: 'autonomous',
    });
  });

  it('falls back to the profile timezone when the browser cannot report one', async () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...real.call(this), timeZone: '' };
      });
    const posts: Record<string, unknown>[] = [];
    installRoutes({
      mutate: (_path, init) => {
        if (init?.method === 'POST') posts.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
        return Promise.resolve({});
      },
    });
    try {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /New schedule/ }));
      const form = within(screen.getByTestId('schedule-form'));
      const zone = form.getByLabelText('Timezone') as HTMLSelectElement;
      expect(zone.value).toBe('');
      expect(within(zone).getByRole('option', { name: 'my profile timezone' })).toBeInTheDocument();
      fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'qib' } });
      await pickDestination(form, '~general');
      fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'x' } });
      fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));
      await waitFor(() => expect(posts).toHaveLength(1));
      // Empty lets the server use the creator's profile zone.
      expect(posts[0].scheduleTZ).toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  it('warns in the form when the chosen agent runs on your own machine', async () => {
    installRoutes();
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    expect(screen.queryByTestId('schedule-form-cli-warning')).not.toBeInTheDocument();
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    expect(screen.getByTestId('schedule-form-cli-warning')).toHaveTextContent('Bedrock agent');
    // Picking the cloud agent clears it.
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'qib' } });
    expect(screen.queryByTestId('schedule-form-cli-warning')).not.toBeInTheDocument();
  });

  it('will not submit until agent, channel and instruction are all set', async () => {
    installRoutes();
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    const submit = form.getByRole('button', { name: 'Schedule it' });
    expect(submit).toBeDisabled();
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    expect(submit).toBeDisabled();
    // The instruction also names the new channel, so one field arms both.
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'revenue digest' } });
    expect(submit).toBeEnabled();
    // Switching destination keeps it ready — an existing channel needs no name.
    await pickDestination(form, '~general');
    expect(submit).toBeEnabled();
    fireEvent.click(form.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('schedule-form')).not.toBeInTheDocument();
  });

  it('deletes a schedule through its own agent', async () => {
    const deletes: string[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'DELETE') deletes.push(path);
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-qib');
    fireEvent.click(screen.getByLabelText(/Delete schedule: every day at 17:30/));
    await waitFor(() =>
      expect(deletes).toContain('/api/v1/agents/qib/subscriptions/ch-1/s-qib'),
    );
  });

  it('toasts when a delete fails', async () => {
    installRoutes({
      mutate: (_path, init) =>
        init?.method === 'DELETE' ? Promise.reject(new Error('boom')) : Promise.resolve({}),
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-qib');
    fireEvent.click(screen.getByLabelText(/Delete schedule: every day at 17:30/));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Couldn't delete that schedule — try again."),
    );
  });

  it('toasts when saving a schedule fails', async () => {
    installRoutes({
      mutate: (_path, init) =>
        init?.method === 'POST' ? Promise.reject(new Error('boom')) : Promise.resolve({}),
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    await pickDestination(form, 'a DM to me');
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'go' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Couldn't save that scheduled order — try again."),
    );
  });

  it('treats an agent whose subscriptions come back missing as having none', async () => {
    installRoutes();
    const base = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path, init) =>
      path === '/api/v1/agents/qib/subscriptions' && !init?.method ? Promise.resolve({}) : base(path, init),
    );
    renderPage();
    expect(await screen.findByTestId('schedule-row-s-gg')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-row-s-qib')).not.toBeInTheDocument();
  });

  it('shows skeletons while agents load', () => {
    installRoutes({ agents: () => new Promise(() => {}) });
    renderPage();
    expect(screen.getByTestId('schedules-loading')).toBeInTheDocument();
  });

  it('offers the weekly day picker only for the weekly cadence', async () => {
    installRoutes();
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    expect(form.queryByLabelText('On')).not.toBeInTheDocument();
    fireEvent.change(form.getByLabelText('Repeats'), { target: { value: 'weekly' } });
    expect(form.getByLabelText('On')).toBeInTheDocument();
  });
});

// The submit button is disabled until the form is ready, so the guard inside
// submit() can't be reached by a real click (React and base-ui both swallow
// clicks on disabled buttons). Walk the fiber tree to the component that owns
// the onClick prop and invoke it directly — same technique the agents-page
// suite uses for the Watch button.
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

describe('SchedulesPage form guards', () => {
  it('refuses to submit an incomplete form even if the click is forced', async () => {
    const posts: string[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'POST') posts.push(path);
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    forceReactClick(form.getByRole('button', { name: 'Schedule it' }));
    expect(posts).toEqual([]);
  });

  it('shows a saving state while the create is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = () => res();
    });
    installRoutes({
      mutate: (_path, init) =>
        init?.method === 'POST' ? gate.then(() => ({})) : Promise.resolve({}),
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    await pickDestination(form, 'a DM to me');
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'go' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByTestId('schedule-form')).not.toBeInTheDocument());
  });
});


describe('SchedulesPage delivery target', () => {
  it('sends no channel when DM is chosen, and keeps the result private', async () => {
    const posts: { body: Record<string, unknown> }[] = [];
    installRoutes({
      mutate: (_path, init) => {
        if (init?.method === 'POST') posts.push({ body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    await pickDestination(form, 'a DM to me');
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'Morning numbers.' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // No parent: the server files it in the caller's DM with the agent.
    expect(posts[0].body.parentID).toBeUndefined();
    expect(posts[0].body.parentType).toBeUndefined();
    expect(posts[0].body.actionMode).toBe('notify');
  });

  it('can create a channel for the schedule, then files the order in it', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'POST') {
          calls.push({ path, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
          if (path === '/api/v1/channels') return Promise.resolve({ id: 'ch-new', name: 'daily-revenue' });
        }
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    // A new channel is the DEFAULT — no switching required.
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    expect(form.getByRole('button', { name: 'Where the result goes' })).toHaveTextContent('a new channel');
    fireEvent.change(form.getByLabelText('Channel name'), { target: { value: '  daily-revenue  ' } });
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'Post the numbers.' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatchObject({
      path: '/api/v1/channels',
      body: { name: 'daily-revenue', type: 'private' },
    });
    // The schedule lands in the channel that was just created.
    expect(calls[1].path).toBe('/api/v1/agents/gg/subscriptions');
    expect(calls[1].body).toMatchObject({ parentID: 'ch-new', parentType: 'channel', actionMode: 'autonomous' });
  });

  it('toasts if the new channel cannot be created, and schedules nothing', async () => {
    const posts: string[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method !== 'POST') return Promise.resolve({});
        if (path === '/api/v1/channels') return Promise.reject(new Error('nope'));
        posts.push(path);
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    fireEvent.change(form.getByLabelText('Channel name'), { target: { value: 'x' } });
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'go' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Couldn't create that channel — try again."),
    );
    expect(posts).toEqual([]);
  });

  it('shows a DM-delivered order as "as a DM" rather than a raw id', async () => {
    installRoutes({
      subs: {
        gg: [
          {
            id: 's-dm',
            agentID: 'ag-gg',
            creatorID: 'u-1',
            parentID: 'conv-42',
            parentType: 'conversation',
            schedule: '0 8 * * *',
            scheduleTZ: 'UTC',
            instruction: 'Morning numbers.',
          },
        ],
        qib: [],
      },
    });
    renderPage();
    const row = await screen.findByTestId('schedule-row-s-dm');
    expect(row).toHaveTextContent('as a DM');
    expect(row).not.toHaveTextContent('conv-42');
  });
});

describe('SchedulesPage tools and channel naming', () => {
  it('keeps the tool picker folded until asked, then pins connectors and skills', async () => {
    const posts: { body: Record<string, unknown> }[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'POST') {
          if (path === '/api/v1/channels') return Promise.resolve({ id: 'ch-new' });
          posts.push({ body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
        }
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));

    // Folded by default — the chips are the noisiest part of the form.
    expect(await form.findByRole('button', { name: '+ tools' })).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-connectors')).not.toBeInTheDocument();

    fireEvent.click(form.getByRole('button', { name: '+ tools' }));
    // Only CONNECTED services can be pinned.
    const conns = within(await screen.findByTestId('schedule-connectors'));
    expect(conns.getByRole('button', { name: '/metabase' })).toBeInTheDocument();
    expect(conns.queryByRole('button', { name: '/gitlab' })).not.toBeInTheDocument();

    fireEvent.click(conns.getByRole('button', { name: '/metabase' }));
    fireEvent.click(within(screen.getByTestId('schedule-skills')).getByRole('button', { name: /release-notes/ }));
    expect(form.getByRole('button', { name: '2 pinned' })).toBeInTheDocument();

    // Chips toggle: clicking a pinned one removes it again.
    fireEvent.click(conns.getByRole('button', { name: '/metabase' }));
    expect(form.getByRole('button', { name: '1 pinned' })).toBeInTheDocument();
    fireEvent.click(conns.getByRole('button', { name: '/metabase' }));
    expect(form.getByRole('button', { name: '2 pinned' })).toBeInTheDocument();

    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'revenue digest' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.connectorSlugs).toEqual(['metabase']);
    expect(posts[0].body.skillIDs).toEqual(['sk-1']);
  });

  it('names the new channel from the instruction until the user edits it', async () => {
    const created: Record<string, unknown>[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'POST' && path === '/api/v1/channels') {
          created.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
          return Promise.resolve({ id: 'ch-new' });
        }
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    fireEvent.change(form.getByLabelText('What should it do?'), {
      target: { value: 'Post yesterday revenue numbers from metabase' },
    });
    // Stopwords dropped, three words kept.
    expect(form.getByLabelText('Channel name')).toHaveValue('yesterday-revenue-numbers');

    // An edit wins and survives further typing in the instruction.
    fireEvent.change(form.getByLabelText('Channel name'), { target: { value: 'revenue-daily' } });
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'something else entirely' } });
    expect(form.getByLabelText('Channel name')).toHaveValue('revenue-daily');

    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ name: 'revenue-daily', type: 'private' });
  });
});

describe('SchedulesPage delivery to a person', () => {
  it('searches for people instead of listing the roster, and hides agents and yourself', async () => {
    installRoutes();
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.click(form.getByRole('button', { name: 'Where the result goes' }));

    // Nothing typed → no roster fetched, just a prompt to search.
    expect(form.getByText('Type 2+ letters to find someone')).toBeInTheDocument();
    expect(mockApiFetch.mock.calls.some(([p]) => p.startsWith('/api/v1/users?q='))).toBe(false);

    fireEvent.change(form.getByLabelText('Where the result goes'), { target: { value: 'manisha' } });
    expect(await destinations(form).findByRole('option', { name: 'a DM to Manisha' })).toBeInTheDocument();
    // u-1 is the viewer (a DM to me already covers that) and Manisha-bot is
    // an agent — neither may be a recipient.
    expect(destinations(form).queryByRole('option', { name: 'a DM to Manisha Me' })).not.toBeInTheDocument();
    expect(destinations(form).queryByRole('option', { name: /Manisha-bot/ })).not.toBeInTheDocument();
  });

  it('lists only the channels you are in, filtered as you type', async () => {
    installRoutes();
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.click(form.getByRole('button', { name: 'Where the result goes' }));
    expect(destinations(form).getByRole('option', { name: '~general' })).toBeInTheDocument();
    // A query that matches no channel hides the group entirely.
    fireEvent.change(form.getByLabelText('Where the result goes'), { target: { value: 'zzz' } });
    expect(destinations(form).queryByRole('option', { name: '~general' })).not.toBeInTheDocument();
  });

  it('opens a group DM with the recipient AND the agent, then schedules into it', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'POST') {
          calls.push({ path, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
          if (path === '/api/v1/conversations') return Promise.resolve({ id: 'conv-new' });
        }
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    await pickDestination(form, 'a DM to Manisha', 'manisha');
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'Send her the numbers.' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    // The agent must be a participant or it could not post there.
    expect(calls[0]).toMatchObject({
      path: '/api/v1/conversations',
      body: { type: 'group', participantIDs: ['u-2', 'ag-gg'] },
    });
    expect(calls[1].path).toBe('/api/v1/agents/gg/subscriptions');
    expect(calls[1].body).toMatchObject({
      parentID: 'conv-new',
      parentType: 'conversation',
      actionMode: 'autonomous',
    });
  });

  it('toasts if the conversation cannot be opened, and schedules nothing', async () => {
    const posts: string[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method !== 'POST') return Promise.resolve({});
        if (path === '/api/v1/conversations') return Promise.reject(new Error('nope'));
        posts.push(path);
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    await pickDestination(form, 'a DM to Manisha', 'manisha');
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'go' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Couldn't open that conversation — try again."),
    );
    expect(posts).toEqual([]);
  });
});

describe('SchedulesPage destination picker dismissal', () => {
  it('closes on Escape and on a click outside, keeping the previous choice', async () => {
    installRoutes();
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    const trigger = () => form.getByRole('button', { name: 'Where the result goes' });

    // Escape abandons the search without changing the destination.
    fireEvent.click(trigger());
    fireEvent.change(form.getByLabelText('Where the result goes'), { target: { value: 'gen' } });
    fireEvent.keyDown(form.getByLabelText('Where the result goes'), { key: 'Escape' });
    expect(trigger()).toHaveTextContent('a new channel');

    // So does a click on the backdrop behind the panel.
    fireEvent.click(trigger());
    const backdrop = document.querySelector('.fixed.inset-0');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(trigger()).toHaveTextContent('a new channel');

    // A search that matches nobody says so rather than looking broken.
    fireEvent.click(trigger());
    fireEvent.change(form.getByLabelText('Where the result goes'), { target: { value: 'zzzz' } });
    expect(await form.findByText(/No one matches/)).toBeInTheDocument();
    // Ordinary typing keys don't dismiss it.
    fireEvent.keyDown(form.getByLabelText('Where the result goes'), { key: 'a' });
    expect(form.getByLabelText('Where the result goes')).toBeInTheDocument();
  });

  it('opens cleanly while channels and skills are still loading', async () => {
    installRoutes({ slowLists: true });
    renderPage();
    // The form is reachable before the lists arrive; it must not crash or
    // offer a half-built picker.
    fireEvent.click(await screen.findByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.click(form.getByRole('button', { name: 'Where the result goes' }));
    expect(destinations(form).getByRole('option', { name: 'a DM to me' })).toBeInTheDocument();
    expect(destinations(form).queryByRole('option', { name: '~general' })).not.toBeInTheDocument();
    // With no skills or connectors loaded there is nothing to pin yet.
    expect(form.queryByRole('button', { name: '+ tools' })).not.toBeInTheDocument();
  });
});

describe('SchedulesPage editing', () => {
  it('opens an order pre-filled, keeps its destination fixed, and saves every field', async () => {
    const patches: { path: string; body: Record<string, unknown> }[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'PATCH') {
          patches.push({ path, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
        }
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit schedule: every weekday at 08:00 (Europe/Stockholm)' }),
    );
    const form = within(screen.getByTestId('schedule-form'));
    expect(form.getByLabelText('Repeats')).toHaveValue('weekdays');
    expect(form.getByLabelText('At')).toHaveValue('08:00');
    expect(form.getByLabelText('Timezone')).toHaveValue('Europe/Stockholm');
    expect(form.getByLabelText('What should it do?')).toHaveValue("Post yesterday's revenue.");
    // Where it posts is part of the order's identity, so it isn't a picker here.
    expect(form.getByTestId('schedule-form-destination')).toHaveTextContent('~general');
    expect(form.queryByRole('button', { name: 'Where the result goes' })).not.toBeInTheDocument();

    fireEvent.change(form.getByLabelText('Repeats'), { target: { value: 'weekly' } });
    fireEvent.change(form.getByLabelText('On'), { target: { value: '2' } });
    fireEvent.change(form.getByLabelText('At'), { target: { value: '09:30' } });
    fireEvent.change(form.getByLabelText('Timezone'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].path).toBe('/api/v1/agents/gg/subscriptions/ch-1/s-gg');
    // Full-state PATCH: a missing schedule would turn the order into a watcher.
    expect(patches[0].body).toEqual({
      instruction: "Post yesterday's revenue.",
      schedule: '30 9 * * 2',
      scheduleTZ: 'Asia/Tokyo',
      connectorSlugs: [],
      skillIDs: [],
    });
    await waitFor(() => expect(screen.queryByTestId('schedule-form')).not.toBeInTheDocument());
  });

  it('keeps a DM order’s pins and profile zone, and toasts when saving fails', async () => {
    installRoutes({
      subs: {
        gg: [
          {
            id: 's-dm',
            agentID: 'ag-gg',
            creatorID: 'u-1',
            parentID: 'conv-42',
            parentType: 'conversation',
            schedule: '0 8 * * *',
            instruction: 'Morning numbers.',
            connectorSlugs: ['metabase'],
            skillIDs: ['sk-1'],
          },
        ],
        qib: [],
      },
      mutate: (_path, init) =>
        init?.method === 'PATCH' ? Promise.reject(new Error('offline')) : Promise.resolve({}),
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-dm');
    fireEvent.click(screen.getByRole('button', { name: /^Edit schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    expect(form.getByTestId('schedule-form-destination')).toHaveTextContent('a DM');
    // No stored zone → the server's profile default, shown as such.
    expect(form.getByLabelText('Timezone')).toHaveValue('');
    expect(await form.findByRole('button', { name: '2 pinned' })).toBeInTheDocument();
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Couldn't save your changes — try again."),
    );
    // Still open, so the edit isn't lost; Cancel closes it.
    fireEvent.click(form.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('schedule-form')).not.toBeInTheDocument();
  });

  it('offers no edit for a spec the form cannot express', async () => {
    installRoutes({
      subs: {
        gg: [
          {
            id: 's-rich',
            agentID: 'ag-gg',
            creatorID: 'u-1',
            parentID: 'ch-1',
            parentType: 'channel',
            schedule: '*/15 * * * *',
            scheduleTZ: 'UTC',
            instruction: 'Poll.',
          },
        ],
        qib: [],
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-rich');
    expect(screen.queryByRole('button', { name: /^Edit schedule/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete schedule/ })).toBeInTheDocument();
  });

  it('names a channel you have since left by its id rather than dropping it', async () => {
    installRoutes({
      subs: {
        gg: [
          {
            id: 's-left',
            agentID: 'ag-gg',
            creatorID: 'u-1',
            parentID: 'ch-left',
            parentType: 'channel',
            schedule: '0 8 * * *',
            scheduleTZ: 'UTC',
            instruction: 'x',
          },
        ],
        qib: [],
      },
    });
    renderPage();
    expect(await screen.findByTestId('schedule-row-s-left')).toHaveTextContent('~ch-left');
  });
});

describe('SchedulesPage new-channel name clashes', () => {
  it('stops on a channel you are already in and offers to post there instead', async () => {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'POST') {
          posts.push({ path, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
        }
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    // Same slug as ~general, different spelling.
    fireEvent.change(form.getByLabelText('Channel name'), { target: { value: 'General' } });
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'go' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));

    const alert = await form.findByTestId('schedule-channel-taken');
    expect(alert).toHaveTextContent('A channel named “General” already exists');
    expect(form.getByLabelText('Channel name')).toHaveAttribute('aria-invalid', 'true');
    expect(posts).toEqual([]);

    // One click switches the destination to that channel.
    fireEvent.click(within(alert).getByRole('button', { name: 'post to ~general' }));
    expect(form.queryByTestId('schedule-channel-taken')).not.toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Where the result goes' })).toHaveTextContent('~general');
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      path: '/api/v1/agents/gg/subscriptions',
      body: { parentID: 'ch-1', parentType: 'channel' },
    });
  });

  it('shows the server’s clash for a channel you can’t see, and clears it once renamed', async () => {
    const subsPosts: string[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method !== 'POST') return Promise.resolve({});
        if (path === '/api/v1/channels') return Promise.reject(new ApiError(409, 'exists'));
        subsPosts.push(path);
        return Promise.resolve({});
      },
    });
    renderPage();
    await screen.findByTestId('schedule-row-s-gg');
    fireEvent.click(screen.getByRole('button', { name: /New schedule/ }));
    const form = within(screen.getByTestId('schedule-form'));
    fireEvent.change(form.getByLabelText('Agent'), { target: { value: 'gg' } });
    fireEvent.change(form.getByLabelText('Channel name'), { target: { value: 'secret-ops' } });
    fireEvent.change(form.getByLabelText('What should it do?'), { target: { value: 'go' } });
    fireEvent.click(form.getByRole('button', { name: 'Schedule it' }));

    const alert = await form.findByTestId('schedule-channel-taken');
    // Not one of yours, so there is nothing to switch to.
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalledWith("Couldn't create that channel — try again.");
    expect(subsPosts).toEqual([]);

    fireEvent.change(form.getByLabelText('Channel name'), { target: { value: 'secret-ops-2' } });
    expect(form.queryByTestId('schedule-channel-taken')).not.toBeInTheDocument();
  });
});
