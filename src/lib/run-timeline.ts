// Pure timeline model for the run activity drawer (plan-v2 Phase 2).
//
// Extracted from the drawer component so it can be reasoned about (and
// memoized) on its own: every function here is a pure transform of the
// timeline response, while the component owns rendering, polling and panel
// state. The component used to recompute all of it on EVERY render —
// including once per pointermove while the panel was being resized.

export interface RunSpend {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  posts: number;
}

export interface TimelineRun {
  id: string;
  agentID: string;
  invokerID: string;
  parentID: string;
  parentType: string;
  state: string;
  round?: number;
  harness: string;
  model?: string;
  personaHash: string;
  spend: RunSpend;
  failReason?: string;
  createdAt: string;
}

export interface TimelineEvent {
  runID: string;
  seq: number;
  actorID: string;
  type: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface RunArtifact {
  id: string;
  kind: string;
  title: string;
  content?: string;
  createdAt: string;
}

export interface ThreadSpend {
  runs: number;
  active: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  posts: number;
}

export interface TimelineResponse {
  run: TimelineRun;
  // Thread mode: every run under the root, oldest first (run = the latest),
  // plus the thread's messages so posts and replies read inline with the work.
  runs?: TimelineRun[];
  messages?: { id: string; authorID: string; body: string; createdAt: string }[];
  events: TimelineEvent[];
  users: Record<string, string>;
  artifacts?: RunArtifact[];
  threadSpend?: ThreadSpend;
}

export const TERMINAL = new Set(['completed', 'failed', 'canceled']);

export function num(payload: Record<string, unknown> | undefined, key: string): number {
  const v = payload?.[key];
  return typeof v === 'number' ? v : 0;
}

export function str(payload: Record<string, unknown> | undefined, key: string): string {
  const v = payload?.[key];
  return typeof v === 'string' ? v : '';
}

export function obj(payload: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const v = payload?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// fmtDur renders a span the way someone reading a timeline wants it: seconds
// with one decimal while sub-minute (so a 4.2s tool call is distinguishable
// from a 4.9s one), whole minutes above that.
export function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m${String(rest).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// shortPath trims a long absolute path to its tail so the file name and its
// nearest folders stay readable in a chip.
export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3).join('/')}`;
}

// ------------------------------------------------------------------ steps

// A Step is one rendered unit of the timeline. Tool steps absorb their result
// (the next tool_result for the same tool name); consecutive progress beats
// merge into one narration block; everything else is a system row.
export type Step =
  | {
      kind: 'tool';
      seq: number;
      at: string;
      name: string; // bare tool name, mcp__ex__ prefix stripped
      detail: string;
      input?: Record<string, unknown>;
      result?: string;
      resultIsError?: boolean;
      durationMs?: number;
    }
  | { kind: 'narration'; seq: number; at: string; text: string }
  | { kind: 'approval'; seq: number; at: string; text: string; state: 'asked' | 'approved' | 'denied' | 'expired' }
  | { kind: 'system'; seq: number; at: string; text: string; tone?: 'ok' | 'bad' | 'muted' }
  | { kind: 'chatter'; seq: number; at: string; text: string }
  // A message posted in the thread (dev's milestone, the requester's steering).
  | { kind: 'message'; seq: number; at: string; author: string; text: string };

export function systemLine(e: TimelineEvent): { text: string; tone?: 'ok' | 'bad' | 'muted' } | null {
  switch (e.type) {
    case 'run.invoked':
      return { text: 'Run invoked', tone: 'muted' };
    case 'run.acknowledged':
      return { text: 'Claimed by the runner', tone: 'muted' };
    case 'context.assembled': {
      const parts = [
        `${num(e.payload, 'threadMessages')} thread messages`,
        `${num(e.payload, 'contextPinned') + num(e.payload, 'contextItems')} shared-context items`,
        `${num(e.payload, 'digests')} peer digests`,
      ];
      const dropped =
        num(e.payload, 'threadMessagesDropped') +
        num(e.payload, 'contextPinnedDropped') +
        num(e.payload, 'contextItemsDropped') +
        num(e.payload, 'digestsDropped');
      const task = e.payload?.['codingTask'] === true ? ', coding-task spec' : '';
      return {
        text: `Context assembled — ${parts.join(', ')}${task}${dropped > 0 ? ` (${dropped} trimmed for budget)` : ''}`,
        tone: 'muted',
      };
    }
    case 'prompt': {
      const est = num(e.payload, 'oursTokensEst');
      const resumed = e.payload?.['resumed'] === true;
      return { text: `Prompt sent — ≈${est.toLocaleString()} tokens from Ex${resumed ? ' (warm resume)' : ''}`, tone: 'muted' };
    }
    case 'connector.attached':
      return { text: `Attached connector ${str(e.payload, 'slug')} — ${str(e.payload, 'reason')}` };
    case 'watch.delivered':
      return { text: 'Watcher result delivered' };
    case 'watch.skipped':
      return { text: 'Watcher decided nothing matched (no delivery)', tone: 'muted' };
    case 'context.written':
      return { text: 'Saved an item to shared context' };
    case 'artifact.created':
      return { text: `Published artifact “${str(e.payload, 'title')}”` };
    case 'skill.invoked':
      return { text: `Used skill “${str(e.payload, 'name')}”` };
    case 'run.queued_offline':
      return { text: 'Queued — waiting for the desktop app to come online', tone: 'muted' };
    case 'run.canceled':
      return { text: 'Stopped by a human', tone: 'bad' };
    case 'run.completed':
      return { text: 'Completed', tone: 'ok' };
    case 'run.failed':
      return { text: `Failed — ${str(e.payload, 'reason') || 'unknown reason'}`, tone: 'bad' };
    case 'workspace.task_created':
      return { text: `Opened coding task in ${str(e.payload, 'project')}` };
    case 'workspace.task_state':
      return { text: `Task ${str(e.payload, 'from')} → ${str(e.payload, 'to')}${str(e.payload, 'note') ? ` — ${str(e.payload, 'note')}` : ''}` };
    default:
      if (e.type.startsWith('workspace.')) {
        return { text: e.type.slice('workspace.'.length).replace(/_/g, ' '), tone: 'muted' };
      }
      return { text: e.type, tone: 'muted' };
  }
}

// buildSteps folds the raw event list into rendered steps.
export function buildSteps(events: TimelineEvent[]): Step[] {
  const steps: Step[] = [];
  // Tool steps awaiting their result, by tool name (FIFO per name).
  const pending = new Map<string, Extract<Step, { kind: 'tool' }>[]>();
  for (const e of events) {
    switch (e.type) {
      case 'tool': {
        const raw = str(e.payload, 'name');
        const step: Extract<Step, { kind: 'tool' }> = {
          kind: 'tool',
          seq: e.seq,
          at: e.createdAt,
          name: raw.replace(/^mcp__ex__/, ''),
          detail: str(e.payload, 'detail'),
          input: obj(e.payload, 'input'),
        };
        steps.push(step);
        const q = pending.get(raw) ?? [];
        q.push(step);
        pending.set(raw, q);
        break;
      }
      case 'tool_result': {
        const raw = str(e.payload, 'name');
        const detail = str(e.payload, 'detail');
        const q = pending.get(raw);
        const target = q?.shift();
        if (target) {
          target.result = detail.replace(/^ERROR:\s*/, '');
          target.resultIsError = detail.startsWith('ERROR:');
          target.durationMs = Math.max(0, new Date(e.createdAt).getTime() - new Date(target.at).getTime());
        } else if (detail) {
          steps.push({ kind: 'system', seq: e.seq, at: e.createdAt, text: `↳ ${detail}`, tone: 'muted' });
        }
        break;
      }
      case 'progress': {
        const text = str(e.payload, 'text').trim();
        if (!text) break;
        const last = steps[steps.length - 1];
        if (last && last.kind === 'narration') {
          last.text = `${last.text}\n${text}`;
        } else {
          steps.push({ kind: 'narration', seq: e.seq, at: e.createdAt, text });
        }
        break;
      }
      case 'approval.requested':
        steps.push({ kind: 'approval', seq: e.seq, at: e.createdAt, text: str(e.payload, 'summary'), state: 'asked' });
        break;
      case 'approval.decided': {
        const st = str(e.payload, 'state') === 'approved' ? 'approved' : 'denied';
        const choice = str(e.payload, 'choice');
        steps.push({
          kind: 'approval',
          seq: e.seq,
          at: e.createdAt,
          text: st === 'approved' ? (choice ? `Approved — chose “${choice}”` : 'Approved') : 'Denied',
          state: st,
        });
        break;
      }
      case 'approval.expired':
        steps.push({ kind: 'approval', seq: e.seq, at: e.createdAt, text: 'Expired undecided (counts as denied)', state: 'expired' });
        break;
      case 'turn':
        steps.push({ kind: 'chatter', seq: e.seq, at: e.createdAt, text: 'Harness turn' });
        break;
      case 'usage': {
        const inTok = num(e.payload, 'inputTokens');
        const outTok = num(e.payload, 'outputTokens');
        steps.push({ kind: 'chatter', seq: e.seq, at: e.createdAt, text: `Tokens — ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out` });
        break;
      }
      case 'state':
        steps.push({ kind: 'chatter', seq: e.seq, at: e.createdAt, text: `State ${str(e.payload, 'state')}` });
        break;
      default: {
        const line = systemLine(e);
        /* istanbul ignore else -- systemLine's default arm always yields a line; null is future-proofing in the signature */
        if (line) steps.push({ kind: 'system', seq: e.seq, at: e.createdAt, ...line });
      }
    }
  }
  return steps;
}

export type ToolFamily = 'shell' | 'edit' | 'write' | 'read' | 'search' | 'web' | 'ex' | 'other';

export function toolFamily(name: string): ToolFamily {
  switch (name) {
    case 'Bash':
    case 'shell':
      return 'shell';
    case 'Edit':
    case 'MultiEdit':
      return 'edit';
    case 'Write':
    case 'NotebookEdit':
      return 'write';
    case 'Read':
    case 'NotebookRead':
      return 'read';
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    default:
      return /^[a-z_]+$/.test(name) ? 'ex' : 'other';
  }
}


// ------------------------------------------------------------------ assembly

export interface RunTiming {
  totalMs: number;
  waitMs: number;
  workMs: number;
}

export interface PromptSplit {
  ours: number;
  harness: number;
}

export interface RunTimeline {
  events: TimelineEvent[];
  timing: RunTiming | null;
  promptSplit: PromptSplit | null;
  steps: Step[];
  toolCount: number;
  editCount: number;
}

const EMPTY_TIMELINE: RunTimeline = {
  events: [],
  timing: null,
  promptSplit: null,
  steps: [],
  toolCount: 0,
  editCount: 0,
};

// buildTimeline folds one timeline response into everything the drawer
// renders. nowMs is the caller's wall clock (the query's dataUpdatedAt), so
// this stays pure and the live "elapsed" figure still advances with the poll.
export function buildTimeline(
  data: TimelineResponse | undefined,
  opts: { showChatter: boolean; nowMs: number; authorName: (id: string) => string },
): RunTimeline {
  if (!data) return EMPTY_TIMELINE;
  const events = data.events
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);

  // Elapsed: wall clock from the first event to the last (or to now while the
  // run is live). Time parked on an approval prompt is a human waiting, not the
  // agent working, so it is subtracted out and reported separately — otherwise
  // a run that sat overnight on a gate reads as an eight-hour agent.
  let timing: RunTiming | null = null;
  if (events.length) {
    const startMs = new Date(events[0].createdAt).getTime();
    const lastMs = new Date(events[events.length - 1].createdAt).getTime();
    const endMs = TERMINAL.has(data.run.state) ? lastMs : Math.max(lastMs, opts.nowMs);
    const totalMs = Math.max(0, endMs - startMs);
    let waitMs = 0;
    let askedAt: number | null = null;
    for (const e of events) {
      if (e.type === 'approval.requested') askedAt = new Date(e.createdAt).getTime();
      else if (askedAt !== null && (e.type === 'approval.decided' || e.type === 'approval.expired')) {
        waitMs += Math.max(0, new Date(e.createdAt).getTime() - askedAt);
        askedAt = null;
      }
    }
    timing = { totalMs, waitMs, workMs: Math.max(0, totalMs - waitMs) };
  }

  let promptSplit: PromptSplit | null = null;
  {
    const p = events.find((e) => e.type === 'prompt');
    const firstUsage = events.find((e) => e.type === 'usage' && num(e.payload, 'inputTokens') > 0);
    if (p && firstUsage) {
      const ours = num(p.payload, 'oursTokensEst');
      const first = num(firstUsage.payload, 'inputTokens');
      if (ours > 0 && first > 0) {
        promptSplit = { ours: Math.min(ours, first), harness: Math.max(0, first - ours) };
      }
    }
  }

  // Thread mode interleaves the thread's messages with the work, by time —
  // the card marker reads as a label, not raw syntax.
  const messageSteps: Step[] = (data.messages ?? []).map((m, i) => ({
    kind: 'message' as const,
    seq: 1_000_000_000 + i,
    at: m.createdAt,
    author: opts.authorName(m.authorID),
    text: m.body.startsWith('[task:') ? '\u{1F4CC} Task card' : m.body,
  }));
  const steps = [...buildSteps(events), ...messageSteps]
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
    .filter((s) => opts.showChatter || s.kind !== 'chatter');

  return {
    events,
    timing,
    promptSplit,
    steps,
    toolCount: steps.filter((s) => s.kind === 'tool').length,
    editCount: steps.filter(
      (s) => s.kind === 'tool' && (toolFamily(s.name) === 'edit' || toolFamily(s.name) === 'write'),
    ).length,
  };
}
