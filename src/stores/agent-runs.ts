import { create } from 'zustand';

// Live agent-run activity, per parent (channel/conversation). Fed by
// run.updated (lifecycle: add on non-terminal, remove on terminal) and
// run.progress (what the agent is doing right now). Mirrors the typing
// store's shape: module state + a zustand store keyed per parent so a
// progress beat in one channel re-renders only that channel's indicator.

// A run with no beat for this long is treated as gone even without a
// terminal run.updated — belt and braces against a lost terminal frame
// (e.g. a socket blip right as the run finished).
const STALE_MS = 90_000;

export interface AgentRunActivity {
  runID: string;
  agentID: string;
  invokerID?: string;
  parentID: string;
  threadRootID?: string;
  state: string;
  // Human-readable "what it's doing" — from the latest progress beat.
  action: string;
  updatedAt: number;
}

interface AgentRunsState {
  runsByParent: Record<string, AgentRunActivity[]>;
}

const entries = new Map<string, AgentRunActivity>(); // runID → activity
// runIDs that reached a terminal state, with when. A run.progress beat can
// arrive AFTER the terminal run.updated (out-of-order over the socket); without
// this tombstone such a beat would re-insert the finished run as live "working…"
// until the stale sweep. Pruned in sweep() once past STALE_MS.
const terminated = new Map<string, number>(); // runID → terminated-at ms
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export const useAgentRunsStore = create<AgentRunsState>(() => ({
  runsByParent: {},
}));

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled']);

// toolLabel narrates a tool call for the activity line.
function toolLabel(tool: string): string {
  switch (tool) {
    case 'post_message':
    case 'mcp__ex__post_message':
      return 'posting a reply…';
    case 'get_thread':
    case 'mcp__ex__get_thread':
      return 'reading the thread…';
    case 'set_state':
    case 'mcp__ex__set_state':
      return 'working…';
    default:
      return tool ? `using ${tool}…` : 'working…';
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case 'queued':
      return 'queued…';
    case 'acknowledged':
      return 'starting up…';
    case 'running':
      return 'working…';
    default:
      return 'working…';
  }
}

function publish(): void {
  const next: Record<string, AgentRunActivity[]> = {};
  for (const e of entries.values()) {
    (next[e.parentID] ??= []).push(e);
  }
  for (const list of Object.values(next)) {
    list.sort((a, b) => a.runID.localeCompare(b.runID)); // stable order
  }
  useAgentRunsStore.setState({ runsByParent: next });
  const wantTimer = entries.size > 0 || terminated.size > 0;
  if (wantTimer && !sweepTimer) {
    sweepTimer = setInterval(sweep, 15_000);
  } else if (!wantTimer && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function sweep(): void {
  const cutoff = Date.now() - STALE_MS;
  let changed = false;
  for (const [id, e] of entries) {
    if (e.updatedAt < cutoff) {
      entries.delete(id);
      changed = true;
    }
  }
  for (const [id, at] of terminated) {
    if (at < cutoff) terminated.delete(id);
  }
  if (changed) publish();
  else if (entries.size === 0 && terminated.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// onRunUpdated ingests a run.updated frame (the full run snapshot).
export function onRunUpdated(data: unknown): void {
  const run = data as {
    id?: string;
    agentID?: string;
    invokerID?: string;
    parentID?: string;
    threadRootID?: string;
    state?: string;
  } | null;
  if (!run?.id || !run.parentID || !run.agentID || !run.state) return;
  if (TERMINAL_STATES.has(run.state)) {
    // "Show activity" on the agent's message is the door to a finished run's
    // drawer — the composer chip tracks LIVE work only.
    terminated.set(run.id, Date.now());
    if (entries.delete(run.id)) publish();
    else publish(); // ensure the sweep timer is armed to prune the tombstone
    return;
  }
  const prev = entries.get(run.id);
  entries.set(run.id, {
    runID: run.id,
    agentID: run.agentID,
    invokerID: run.invokerID,
    parentID: run.parentID,
    threadRootID: run.threadRootID,
    state: run.state,
    action: prev?.action ?? stateLabel(run.state),
    updatedAt: Date.now(),
  });
  publish();
}

// onRunProgress ingests a run.progress beat (ephemeral activity).
export function onRunProgress(data: unknown): void {
  const p = data as {
    runID?: string;
    agentID?: string;
    invokerID?: string;
    parentID?: string;
    threadRootID?: string;
    kind?: string;
    text?: string;
    tool?: string;
  } | null;
  if (!p?.runID || !p.parentID || !p.agentID) return;
  // Ignore a beat for a run that already terminated — a terminal run.updated
  // won and the chip is gone; don't resurrect it from an out-of-order beat.
  if (terminated.has(p.runID)) return;
  let action: string;
  switch (p.kind) {
    case 'tool':
      action = toolLabel(p.tool ?? '');
      break;
    case 'text': {
      const snippet = (p.text ?? '').replace(/\s+/g, ' ').trim();
      action = snippet ? `“${snippet.slice(0, 90)}${snippet.length > 90 ? '…' : ''}”` : 'thinking…';
      break;
    }
    default:
      action = 'working…';
  }
  const prev = entries.get(p.runID);
  entries.set(p.runID, {
    runID: p.runID,
    agentID: p.agentID,
    invokerID: p.invokerID ?? prev?.invokerID,
    parentID: p.parentID,
    threadRootID: p.threadRootID ?? prev?.threadRootID,
    state: prev?.state ?? 'running',
    action,
    updatedAt: Date.now(),
  });
  publish();
}

const EMPTY: AgentRunActivity[] = [];

// useAgentRunsFor subscribes to one parent's active runs.
export function useAgentRunsFor(parentID: string): AgentRunActivity[] {
  return useAgentRunsStore((s) => s.runsByParent[parentID] ?? EMPTY);
}

// resetAgentRunsSessionState clears everything (logout / tests).
export function resetAgentRunsSessionState(): void {
  entries.clear();
  terminated.clear();
  publish();
}
