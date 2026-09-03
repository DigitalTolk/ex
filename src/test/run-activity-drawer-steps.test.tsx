import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunActivityDrawer } from '@/components/chat/RunActivityDrawer';
import { closeRunDrawer, openRunDrawer } from '@/stores/run-drawer';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

let seqCounter = 0;
const T0 = Date.parse('2026-01-01T10:00:00.000Z');
function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}
function ev(type: string, payload?: Record<string, unknown>, offsetMs = 0) {
  seqCounter += 1;
  return { runID: 'run-1', seq: seqCounter, actorID: 'ag-1', type, payload, createdAt: at(offsetMs) };
}

function timeline(events: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    run: {
      id: 'run-1',
      agentID: 'ag-1',
      invokerID: 'u-1',
      parentID: 'c-1',
      parentType: 'channel',
      state: 'completed',
      harness: 'claude-code',
      personaHash: 'h',
      spend: { turns: 1, inputTokens: 1, outputTokens: 1, posts: 0 },
      createdAt: at(-1000),
    },
    events,
    users: { 'ag-1': 'gg', 'u-1': 'Ada' },
  };
}

async function renderTimeline(events: unknown[], extra: Record<string, unknown> = {}) {
  mockApiFetch.mockImplementation(() => Promise.resolve(timeline(events, extra)));
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => openRunDrawer('run-1'));
  render(
    <QueryClientProvider client={qc}>
      <RunActivityDrawer />
    </QueryClientProvider>,
  );
  const drawer = await screen.findByTestId('run-activity-drawer');
  await screen.findByText('claude-code');
  return drawer;
}

beforeEach(() => {
  seqCounter = 0;
  mockApiFetch.mockReset();
});

afterEach(() => {
  act(() => closeRunDrawer());
});

describe('RunActivityDrawer timeline steps', () => {
  it('renders a shell step folded with a result preview, expands to command + description + output', async () => {
    const drawer = await renderTimeline([
      ev('tool', { name: 'Bash', detail: 'list', input: { command: 'ls -la\nwc -l', description: 'List files' } }),
      ev('tool_result', { name: 'Bash', detail: 'total 12' }, 4200),
    ]);
    // Folded: title shows the first command line, preview shows the result.
    expect(within(drawer).getByText('ran')).toBeInTheDocument();
    expect(within(drawer).getByText('ls -la')).toBeInTheDocument();
    expect(within(drawer).getByText(/↳\s*total 12/)).toBeInTheDocument();
    // Duration 4.2s shows next to the step.
    expect(within(drawer).getByText(/4\.2s ·/)).toBeInTheDocument();

    fireEvent.click(within(drawer).getByText('ran'));
    expect(within(drawer).getByText(/ls -la\s*wc -l/)).toBeInTheDocument();
    expect(within(drawer).getByText('List files')).toBeInTheDocument();
    expect(within(drawer).getByText('total 12')).toBeInTheDocument();
  });

  it('truncates a >90-char command in the title and shows a shell step without command via its detail', async () => {
    const long = 'echo ' + 'x'.repeat(120);
    const drawer = await renderTimeline([
      ev('tool', { name: 'shell', detail: 'fallback detail', input: {} }),
      ev('tool_result', { name: 'shell', detail: 'ok' }, 100),
      ev('tool', { name: 'Bash', detail: 'long', input: { command: long } }, 200),
    ]);
    expect(within(drawer).getByText('fallback detail')).toBeInTheDocument();
    expect(within(drawer).getByText(new RegExp('^echo x+…$'))).toBeInTheDocument();
  });

  it('renders an edit step open with a red/green diff, and an error result inline', async () => {
    const drawer = await renderTimeline([
      ev('tool', {
        name: 'Edit',
        detail: 'patch',
        input: { file_path: '/repo/deep/nested/src/file.ts', old_string: 'old line', new_string: 'new line' },
      }),
      ev('tool_result', { name: 'Edit', detail: 'ERROR: no match' }, 100),
    ]);
    expect(within(drawer).getByText('edited')).toBeInTheDocument();
    expect(within(drawer).getByText('…/nested/src/file.ts')).toBeInTheDocument();
    // Open by default: diff visible without clicking.
    expect(within(drawer).getByText('old line')).toBeInTheDocument();
    expect(within(drawer).getByText('new line')).toBeInTheDocument();
    expect(within(drawer).getByText('no match')).toBeInTheDocument();
    // Collapsing shows the error preview.
    fireEvent.click(within(drawer).getByText('edited'));
    expect(within(drawer).getByText(/error:\s*no match/)).toBeInTheDocument();
  });

  it('renders write, read, search and web steps with their operand chips', async () => {
    const drawer = await renderTimeline([
      ev('tool', { name: 'Write', detail: '', input: { file_path: '/a/b.ts', content: 'body text' } }),
      ev('tool', { name: 'NotebookEdit', detail: '', input: { notebook_path: '/n/nb.ipynb' } }, 100),
      ev('tool', { name: 'Read', detail: '', input: { file_path: '/a/c.ts' } }, 200),
      ev('tool_result', { name: 'Read', detail: 'file body' }, 300),
      ev('tool', { name: 'Grep', detail: '', input: { pattern: 'TODO', path: '/repo' } }, 400),
      ev('tool', { name: 'Glob', detail: '', input: {} }, 500),
      ev('tool', { name: 'WebSearch', detail: '', input: { query: 'vitest docs' } }, 600),
      ev('tool', { name: 'WebFetch', detail: '', input: { url: 'https://x.test' } }, 700),
      ev('tool', { name: 'WebFetch', detail: 'fetched something', input: {} }, 800),
    ]);
    expect(within(drawer).getAllByText('wrote')).toHaveLength(2);
    // Title chip + the auto-opened write body both carry the path.
    expect(within(drawer).getAllByText('/a/b.ts')).toHaveLength(2);
    expect(within(drawer).getByText('body text')).toBeInTheDocument();
    expect(within(drawer).getByText('/n/nb.ipynb')).toBeInTheDocument();
    expect(within(drawer).getByText('read')).toBeInTheDocument();
    expect(within(drawer).getByText('/a/c.ts')).toBeInTheDocument();
    expect(within(drawer).getAllByText('searched').length).toBe(2);
    expect(within(drawer).getByText('TODO')).toBeInTheDocument();
    expect(within(drawer).getByText('in')).toBeInTheDocument();
    expect(within(drawer).getByText('/repo')).toBeInTheDocument();
    expect(within(drawer).getByText('Glob')).toBeInTheDocument();
    expect(within(drawer).getByText('searched the web for')).toBeInTheDocument();
    expect(within(drawer).getByText('vitest docs')).toBeInTheDocument();
    expect(within(drawer).getAllByText('fetched').length).toBe(2);
    expect(within(drawer).getByText('https://x.test')).toBeInTheDocument();
    expect(within(drawer).getByText('fetched something')).toBeInTheDocument();
  });

  it('renders ex tools by detail, other tools by name, and expands json input', async () => {
    const drawer = await renderTimeline([
      ev('tool', { name: 'mcp__ex__post_message', detail: 'posting to ~general', input: { json: '{"a":1}' } }),
      ev('tool', { name: 'CustomTool', detail: '', input: {} }, 100),
      ev('tool_result', { name: 'CustomTool', detail: 'done' }, 200),
      ev('tool', { name: 'get_thread', detail: '' }, 300),
    ]);
    expect(within(drawer).getByText('posting to ~general')).toBeInTheDocument();
    expect(within(drawer).getByText('CustomTool')).toBeInTheDocument();
    // json body renders once expanded (open via click).
    fireEvent.click(within(drawer).getByText('posting to ~general'));
    expect(within(drawer).getByText('{"a":1}')).toBeInTheDocument();
    // A bare tool call with no body has no chevron affordance and ignores clicks.
    const bare = within(drawer).getByText('get_thread');
    fireEvent.click(bare);
    expect(bare).toBeInTheDocument();
  });

  it('pairs results FIFO per tool name and shows orphan results as system rows', async () => {
    const drawer = await renderTimeline([
      ev('tool', { name: 'Bash', detail: '', input: { command: 'first' } }),
      ev('tool', { name: 'Bash', detail: '', input: { command: 'second' } }, 100),
      ev('tool_result', { name: 'Bash', detail: 'out-first' }, 90_000),
      ev('tool_result', { name: 'Bash', detail: 'out-second' }, 90_100),
      ev('tool_result', { name: 'Bash', detail: 'orphan output' }, 90_200),
      ev('tool_result', { name: 'Bash', detail: '' }, 90_300),
    ]);
    expect(within(drawer).getByText(/↳\s*out-first/)).toBeInTheDocument();
    expect(within(drawer).getByText(/↳\s*out-second/)).toBeInTheDocument();
    expect(within(drawer).getByText(/↳\s*orphan output/)).toBeInTheDocument();
    // A 90s duration renders in minutes.
    // Two 90s durations plus the 90s amber gap ahead of the orphan row.
    expect(within(drawer).getAllByText(/1m30s ·/)).toHaveLength(3);
  });

  it('renders narration, approvals in every state, and skips empty progress beats', async () => {
    const drawer = await renderTimeline([
      ev('progress', { text: '  ' }),
      ev('tool', { name: 'Read', detail: '', input: { file_path: '/x.ts' } }, 100),
      ev('progress', { text: 'looking at the failing test' }, 40_000),
      ev('approval.requested', { summary: 'run the deploy?' }, 41_000),
      ev('approval.decided', { state: 'approved', choice: 'staging' }, 42_000),
      ev('approval.decided', { state: 'approved' }, 43_000),
      ev('approval.decided', { state: 'denied' }, 44_000),
      ev('approval.expired', {}, 45_000),
    ]);
    expect(within(drawer).getByText('looking at the failing test')).toBeInTheDocument();
    // A ≥30s gap renders amber.
    expect(within(drawer).getByText('+40s ·')).toBeInTheDocument();
    expect(within(drawer).getByText(/Asked for approval —\s*run the deploy\?/)).toBeInTheDocument();
    expect(within(drawer).getByText('Approved — chose “staging”')).toBeInTheDocument();
    expect(within(drawer).getByText('Approved')).toBeInTheDocument();
    expect(within(drawer).getByText('Denied')).toBeInTheDocument();
    expect(within(drawer).getByText('Expired undecided (counts as denied)')).toBeInTheDocument();
  });

  it('falls back to generic operands, renders one-sided diffs, error write results and bare tool bodies', async () => {
    const drawer = await renderTimeline(
      [
        // Edit with no input at all: 'file' chip and an empty two-sided diff.
        ev('tool', { name: 'Edit', detail: '', input: {} }),
        // One-sided diffs.
        ev('tool', { name: 'Edit', detail: '', input: { old_string: 'gone' } }, 50),
        ev('tool', { name: 'Edit', detail: '', input: { new_string: 'added' } }, 60),
        // Write with no path and an error result (write body shows it inline).
        ev('tool', { name: 'Write', detail: '', input: {} }, 100),
        ev('tool_result', { name: 'Write', detail: 'ERROR: denied' }, 200),
        // Read with no path 40s later: amber gap stamp on a tool step.
        ev('tool', { name: 'Read', detail: '', input: {} }, 40_300),
        // Bare ex tool with a result but no input: expandable body, no json.
        ev('tool', { name: 'get_thread', detail: 'reading the thread' }, 40_400),
        ev('tool_result', { name: 'get_thread', detail: 'thread body here' }, 40_500),
        // Notebook write with content: body shows the notebook path arm.
        ev('tool', { name: 'NotebookEdit', detail: '', input: { notebook_path: '/n/nb2.ipynb', content: 'cells' } }, 40_600),
        // An ask that expired with no decision still counts as waiting time.
        ev('approval.requested', { summary: 'go?' }, 41_000),
        ev('approval.expired', {}, 43_000),
        // Two steps sharing a timestamp order by seq.
        ev('tool', { name: 'Bash', detail: '', input: { command: 'same-a' } }, 50_000),
        ev('tool', { name: 'Bash', detail: '', input: { command: 'same-b' } }, 50_000),
      ],
      {
        threadSpend: { runs: 2, active: 0, turns: 4, inputTokens: 300, outputTokens: 100, posts: 3 },
        artifacts: [{ id: 'r-raw', kind: 'api_response', title: 'GET /x', createdAt: at(0) }],
      },
    );
    // Pathless operands fall back to a generic chip.
    expect(within(drawer).getAllByText('file')).toHaveLength(5);
    // One-sided diffs render only their present side.
    expect(within(drawer).getByText('gone')).toBeInTheDocument();
    expect(within(drawer).getByText('added')).toBeInTheDocument();
    // The write error renders in its auto-opened body.
    expect(within(drawer).getByText('denied')).toBeInTheDocument();
    // Amber gap stamp for the 40s pause ahead of the read step.
    expect(within(drawer).getByText('+40s ·')).toHaveClass('text-amber-600');
    // Bare tool: expanding shows the result with no json block.
    fireEvent.click(within(drawer).getByText('reading the thread'));
    expect(within(drawer).getByText('thread body here')).toBeInTheDocument();
    expect(within(drawer).getAllByText('/n/nb2.ipynb')).toHaveLength(2);
    expect(within(drawer).getByText('cells')).toBeInTheDocument();
    // Undecided ask counted as approval wait.
    expect(within(drawer).getByText(/awaiting approval/)).toBeInTheDocument();
    // Same-timestamp steps keep event order (seq tiebreak).
    const html = drawer.innerHTML;
    expect(html.indexOf('same-a')).toBeGreaterThan(-1);
    expect(html.indexOf('same-a')).toBeLessThan(html.indexOf('same-b'));
    // Conversation spend without active runs omits the active suffix.
    expect(within(drawer).getByText(/2 turns ·\s*400 tokens ·\s*3 posts$/)).toBeInTheDocument();
    // A raw API response without content renders an empty body.
    expect(within(drawer).getByText('GET /x')).toBeInTheDocument();
  });

  it('narrates every lifecycle and system event type', async () => {
    const drawer = await renderTimeline([
      ev('run.invoked'),
      ev('run.acknowledged', undefined, 100),
      ev('context.assembled', { threadMessages: 5, contextPinned: 1, contextItems: 2, digests: 3, threadMessagesDropped: 1, codingTask: true }, 200),
      ev('context.assembled', { threadMessages: '5' }, 300),
      ev('prompt', { oursTokensEst: 900 }, 400),
      ev('connector.attached', { slug: 'gitlab', reason: 'mentioned an MR' }, 500),
      ev('watch.delivered', undefined, 600),
      ev('watch.skipped', undefined, 700),
      ev('context.written', undefined, 800),
      ev('artifact.created', { title: 'Notes' }, 900),
      ev('skill.invoked', { name: 'release-notes' }, 1000),
      ev('run.queued_offline', undefined, 1100),
      ev('run.canceled', undefined, 1200),
      ev('run.completed', undefined, 1300),
      ev('run.failed', {}, 1400),
      ev('workspace.task_created', { project: 'ex' }, 1500),
      ev('workspace.task_state', { from: 'open', to: 'review', note: 'MR up' }, 1600),
      ev('workspace.task_state', { from: 'review', to: 'done' }, 1700),
      ev('workspace.branch_pushed', undefined, 1800),
      ev('totally.unknown', undefined, 1900),
    ]);
    expect(within(drawer).getByText('Run invoked')).toBeInTheDocument();
    expect(within(drawer).getByText('Claimed by the runner')).toBeInTheDocument();
    expect(
      within(drawer).getByText('Context assembled — 5 thread messages, 3 shared-context items, 3 peer digests, coding-task spec (1 trimmed for budget)'),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText('Context assembled — 0 thread messages, 0 shared-context items, 0 peer digests'),
    ).toBeInTheDocument();
    expect(within(drawer).getByText('Prompt sent — ≈900 tokens from Ex')).toBeInTheDocument();
    expect(within(drawer).getByText('Attached connector gitlab — mentioned an MR')).toBeInTheDocument();
    expect(within(drawer).getByText('Watcher result delivered')).toBeInTheDocument();
    expect(within(drawer).getByText('Watcher decided nothing matched (no delivery)')).toBeInTheDocument();
    expect(within(drawer).getByText('Saved an item to shared context')).toBeInTheDocument();
    expect(within(drawer).getByText('Published artifact “Notes”')).toBeInTheDocument();
    expect(within(drawer).getByText('Used skill “release-notes”')).toBeInTheDocument();
    expect(within(drawer).getByText('Queued — waiting for the desktop app to come online')).toBeInTheDocument();
    expect(within(drawer).getByText('Stopped by a human')).toBeInTheDocument();
    expect(within(drawer).getByText('Completed')).toBeInTheDocument();
    expect(within(drawer).getByText('Failed — unknown reason')).toBeInTheDocument();
    expect(within(drawer).getByText('Opened coding task in ex')).toBeInTheDocument();
    expect(within(drawer).getByText('Task open → review — MR up')).toBeInTheDocument();
    expect(within(drawer).getByText('Task review → done')).toBeInTheDocument();
    expect(within(drawer).getByText('branch pushed')).toBeInTheDocument();
    expect(within(drawer).getByText('totally.unknown')).toBeInTheDocument();
  });
});
