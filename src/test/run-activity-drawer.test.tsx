import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunActivityDrawer } from '@/components/chat/RunActivityDrawer';
import { closeRunDrawer, openRunDrawer, openThreadDrawer, useRunDrawerStore } from '@/stores/run-drawer';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

let seqCounter = 0;
function ev(type: string, payload?: Record<string, unknown>, at = '2026-01-01T10:00:00.000Z', seq?: number) {
  seqCounter += 1;
  return { runID: 'run-1', seq: seq ?? seqCounter, actorID: 'ag-1', type, payload, createdAt: at };
}

function runFx(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    agentID: 'ag-1',
    invokerID: 'u-1',
    parentID: 'c-1',
    parentType: 'channel',
    state: 'completed',
    harness: 'claude-code',
    personaHash: 'h',
    spend: { turns: 3, inputTokens: 700, outputTokens: 200, posts: 1 },
    createdAt: '2026-01-01T09:59:00.000Z',
    ...over,
  };
}

const usersFx = { 'ag-1': 'gg', 'u-1': 'Ada' };

function installTimeline(data: unknown, over: { stop?: (path: string) => Promise<unknown> } = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (init?.method === 'POST' && path.endsWith('/stop')) {
      return (over.stop ?? (() => Promise.resolve({})))(path);
    }
    if (data instanceof Error) return Promise.reject(data);
    return Promise.resolve(data);
  });
}

function renderDrawer() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RunActivityDrawer />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  seqCounter = 0;
  mockApiFetch.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  act(() => closeRunDrawer());
});

describe('RunActivityDrawer', () => {
  it('renders nothing while no run or thread is targeted', () => {
    installTimeline({ run: runFx(), events: [], users: {} });
    renderDrawer();
    expect(screen.queryByTestId('run-activity-drawer')).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('loads a single run, shows the config snapshot and closes via the X and Escape', async () => {
    installTimeline({
      run: runFx({ model: 'opus', round: 2, failReason: 'boom', state: 'failed' }),
      events: [ev('run.invoked'), ev('run.failed', { reason: 'boom' }, '2026-01-01T10:00:04.200Z')],
      users: usersFx,
      threadSpend: { runs: 2, active: 1, turns: 5, inputTokens: 400, outputTokens: 100, posts: 2 },
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runs/run-1', undefined);
    await waitFor(() => expect(within(drawer).getByText('gg')).toBeInTheDocument());
    expect(within(drawer).getByText('for Ada')).toBeInTheDocument();
    expect(within(drawer).getByText('failed')).toBeInTheDocument();
    expect(within(drawer).getByText('claude-code · opus')).toBeInTheDocument();
    expect(within(drawer).getByText('Chain round')).toBeInTheDocument();
    expect(within(drawer).getByText(/3 turns · 900 tokens ·\s*1 posts/)).toBeInTheDocument();
    // Elapsed from first to last event on a terminal run: 4.2s, no approval wait.
    expect(within(drawer).getByText('4.2s')).toBeInTheDocument();
    // Conversation-wide spend with an active run.
    expect(within(drawer).getByText(/2 turns ·\s*500 tokens ·\s*2 posts\s*· 1 active/)).toBeInTheDocument();
    expect(within(drawer).getByText('boom', { selector: '.font-mono' })).toBeInTheDocument();
    // Terminal run: no stop button, no working footer.
    expect(within(drawer).queryByText('Stop')).not.toBeInTheDocument();
    expect(within(drawer).queryByText('working…')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'a' });
    expect(useRunDrawerStore.getState().runID).toBe('run-1');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useRunDrawerStore.getState().runID).toBeNull();
  });

  it('close button clears the drawer target', async () => {
    installTimeline({ run: runFx(), events: [], users: {} });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    await screen.findByTestId('run-activity-drawer');
    fireEvent.click(screen.getByLabelText('Close run activity'));
    expect(useRunDrawerStore.getState().runID).toBeNull();
    expect(screen.queryByTestId('run-activity-drawer')).not.toBeInTheDocument();
  });

  it('shows the loading state, then the access-error state', async () => {
    installTimeline(new Error('403'));
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText(/Couldn’t load this run/)).toBeInTheDocument();
  });

  it('polls a live run, offers Stop, and reports elapsed with approval wait subtracted', async () => {
    const now = Date.now();
    const iso = (offMs: number) => new Date(now - 60_000 + offMs).toISOString();
    installTimeline({
      run: runFx({ state: 'running', round: 0 }),
      events: [
        ev('run.invoked', undefined, iso(0)),
        ev('approval.requested', { summary: 'may I?' }, iso(1000)),
        ev('approval.decided', { state: 'approved' }, iso(3000)),
      ],
      users: usersFx,
      threadSpend: { runs: 1, active: 0, turns: 1, inputTokens: 1, outputTokens: 1, posts: 0 },
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    await waitFor(() => expect(within(drawer).getByText('running')).toBeInTheDocument());
    // Live run: spinner badge, stop button, working footer, no model suffix,
    // no chain-round row (round 0), no conversation row (single run).
    expect(within(drawer).getByText('claude-code')).toBeInTheDocument();
    expect(within(drawer).queryByText('Chain round')).not.toBeInTheDocument();
    expect(within(drawer).queryByText('Conversation')).not.toBeInTheDocument();
    expect(within(drawer).getByText('working…')).toBeInTheDocument();
    expect(within(drawer).getByText(/awaiting approval/)).toBeInTheDocument();

    const stop = within(drawer).getByRole('button', { name: 'Stop' });
    fireEvent.click(stop);
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/runs/run-1/stop',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
      ),
    );
    await waitFor(() => expect(stop).toBeEnabled());
  });

  it('keeps the drawer usable when the stop call fails', async () => {
    installTimeline(
      { run: runFx({ state: 'running' }), events: [ev('run.invoked')], users: usersFx },
      { stop: () => Promise.reject(new Error('already done')) },
    );
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const stop = await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(stop);
    await waitFor(() => expect(stop).toBeEnabled());
  });

  it('opens a whole thread, interleaving posted messages with the work', async () => {
    installTimeline({
      run: runFx(),
      events: [ev('run.invoked', undefined, '2026-01-01T10:00:01.000Z')],
      users: usersFx,
      messages: [
        { id: 'm-1', authorID: 'u-1', body: 'please fix the tests', createdAt: '2026-01-01T10:00:00.000Z' },
        { id: 'm-2', authorID: 'u-ghost', body: '[task:abc] card', createdAt: '2026-01-01T10:00:02.000Z' },
      ],
    });
    act(() => openThreadDrawer('c-1', 'root-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runs/thread?parent=c-1&root=root-1', undefined);
    await waitFor(() => expect(within(drawer).getByText('please fix the tests')).toBeInTheDocument());
    // Unknown author falls back to the raw id; a task marker reads as a card label.
    expect(within(drawer).getByText('u-ghost')).toBeInTheDocument();
    expect(within(drawer).getByText('📌 Task card')).toBeInTheDocument();
  });

  it('lists artifacts (single one expanded) with working copy buttons and raw API responses folded', async () => {
    installTimeline({
      run: runFx(),
      events: [],
      users: usersFx,
      artifacts: [
        { id: 'a-1', kind: 'text', title: 'Release notes', content: 'v1 shipped', createdAt: '2026-01-01T10:00:00Z' },
        { id: 'r-1', kind: 'api_response', title: 'GET /users', content: '{"ok":true}', createdAt: '2026-01-01T10:00:00Z' },
      ],
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    await waitFor(() => expect(within(drawer).getByText('Release notes')).toBeInTheDocument());
    // Two artifacts total, so the single non-api one is not auto-expanded.
    const details = within(drawer).getByText('Release notes').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(within(drawer).getByText(/API responses \(raw\) —\s*1 calls/)).toBeInTheDocument();
    expect(within(drawer).getByText('GET /users')).toBeInTheDocument();
    expect(within(drawer).getByText('{"ok":true}')).toBeInTheDocument();

    const copy = within(drawer).getByTitle('Copy artifact content');
    fireEvent.click(copy);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('v1 shipped');
    await waitFor(() => expect(within(copy).queryByText('', { selector: '.text-green-500' })).toBeDefined());
    // The feedback reverts after 1.5s.
    await waitFor(() => expect(copy.querySelector('.text-green-500')).toBeNull(), { timeout: 3000 });
  });

  it('auto-expands a lone artifact and copies empty content as an empty string', async () => {
    installTimeline({
      run: runFx(),
      events: [],
      users: usersFx,
      artifacts: [{ id: 'a-1', kind: 'markdown', title: 'Plan', createdAt: '2026-01-01T10:00:00Z' }],
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    await waitFor(() => expect(within(drawer).getByText('Plan')).toBeInTheDocument());
    expect(within(drawer).getByText('Plan').closest('details')).toHaveAttribute('open');
    expect(within(drawer).queryByText(/API responses/)).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByTitle('Copy artifact content'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('');
  });

  it('shows the first-turn token split when a prompt estimate and usage exist', async () => {
    installTimeline({
      run: runFx(),
      events: [
        ev('prompt', { oursTokensEst: 100, resumed: true }),
        ev('usage', { inputTokens: 150, outputTokens: 10 }, '2026-01-01T10:00:01.000Z'),
      ],
      users: usersFx,
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    await waitFor(() => expect(within(drawer).getByText('First turn')).toBeInTheDocument());
    expect(within(drawer).getByText(/Ex ≈100 · harness ≈50 tokens/)).toBeInTheDocument();
    expect(within(drawer).getByText(/warm resume/)).toBeInTheDocument();
  });

  it('hides the split when the prompt estimate is zero and clamps ours to the first turn', async () => {
    installTimeline({
      run: runFx(),
      events: [ev('prompt', { oursTokensEst: 0 }), ev('usage', { inputTokens: 150, outputTokens: 1 }, '2026-01-01T10:00:01.000Z')],
      users: usersFx,
    });
    act(() => openRunDrawer('run-1'));
    const first = renderDrawer();
    await screen.findByTestId('run-activity-drawer');
    await waitFor(() => expect(screen.getByText(/Prompt sent/)).toBeInTheDocument());
    expect(screen.queryByText('First turn')).not.toBeInTheDocument();
    first.unmount();

    // ours larger than the first usage clamps to it (min/max arms).
    installTimeline({
      run: runFx(),
      events: [
        ev('prompt', { oursTokensEst: 200 }),
        ev('usage', { inputTokens: 150, outputTokens: 1 }, '2026-01-01T10:00:01.000Z'),
      ],
      users: usersFx,
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    await waitFor(() => expect(screen.getByText(/Ex ≈150 · harness ≈0 tokens/)).toBeInTheDocument());
  });

  it('hides the split when no usage event carries tokens', async () => {
    installTimeline({
      run: runFx(),
      events: [ev('prompt', { oursTokensEst: 100 }), ev('usage', { inputTokens: 0, outputTokens: 0 }, '2026-01-01T10:00:01.000Z')],
      users: usersFx,
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    await waitFor(() => expect(within(drawer).getByText(/Prompt sent/)).toBeInTheDocument());
    expect(within(drawer).queryByText('First turn')).not.toBeInTheDocument();
  });

  it('folds harness chatter behind the toggle and counts tools and edits in the spend row', async () => {
    installTimeline({
      run: runFx({ spend: { turns: 1, inputTokens: 1, outputTokens: 1, posts: 0 } }),
      events: [
        ev('turn'),
        ev('usage', { inputTokens: 800, outputTokens: 120 }, '2026-01-01T10:00:01.000Z'),
        ev('state', { state: 'running' }, '2026-01-01T10:00:02.000Z'),
        ev('tool', { name: 'Edit', detail: 'a.ts', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }, '2026-01-01T10:00:03.000Z'),
        ev('tool', { name: 'Read', detail: 'b.ts', input: { file_path: '/w/b.ts' } }, '2026-01-01T10:00:04.000Z'),
      ],
      users: usersFx,
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    await waitFor(() => expect(within(drawer).getByText(/2 tool calls \(1 edits\)/)).toBeInTheDocument());
    expect(within(drawer).queryByText('Harness turn')).not.toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole('checkbox'));
    expect(within(drawer).getByText('Harness turn')).toBeInTheDocument();
    expect(within(drawer).getByText('Tokens — 800 in / 120 out')).toBeInTheDocument();
    expect(within(drawer).getByText('State running')).toBeInTheDocument();
  });

  it('orders events by time with seq as the tiebreaker', async () => {
    const at = '2026-01-01T10:00:00.000Z';
    installTimeline({
      run: runFx(),
      events: [
        ev('progress', { text: 'second' }, at, 2),
        ev('progress', { text: 'first' }, at, 1),
        ev('run.completed', undefined, '2026-01-01T10:00:01.000Z', 3),
      ],
      users: usersFx,
    });
    act(() => openRunDrawer('run-1'));
    renderDrawer();
    const drawer = await screen.findByTestId('run-activity-drawer');
    // Consecutive progress beats merge into one narration block, in seq order.
    const block = await within(drawer).findByText(/first\s*second/);
    expect(block).toBeInTheDocument();
    expect(within(drawer).getByText('Completed')).toBeInTheDocument();
  });
});
