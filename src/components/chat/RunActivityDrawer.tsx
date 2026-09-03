import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Check,
  ChevronRight,
  Copy,
  FileCode2,
  FilePen,
  FilePlus2,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Plug,
  Search,
  ShieldAlert,
  Square,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { PanelResizeHandle } from '@/components/layout/PanelResizeHandle';
import { usePanelWidth } from '@/hooks/usePanelWidth';
import { apiFetch } from '@/lib/api';
import { RUN_DRAWER_WIDTH } from '@/lib/panel-width';
import { closeRunDrawer, useRunDrawerStore } from '@/stores/run-drawer';

// Run Activity Drawer (plan-v2 Phase 2): the replayable audit view of one
// agent run — what config it snapshotted (harness/model), what context it
// was given (the context.assembled counts), every tool call and progress
// beat, and how it ended. Data is GET /api/v1/runs/{id}; while the run is
// live the query polls so the timeline grows in place.
//
// The timeline reads like an IDE agent panel, not a log dump: each tool call
// is a step with an icon, a title (the file, the command, the API path), and
// an expandable body — command + output for the shell, a red/green diff for
// edits, file contents for reads/writes; the model's narration shows as
// speech; approvals stand out in amber; harness chatter (turns, token ticks)
// is folded away behind a toggle.

interface RunSpend {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  posts: number;
}

interface TimelineRun {
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

interface TimelineEvent {
  runID: string;
  seq: number;
  actorID: string;
  type: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

interface RunArtifact {
  id: string;
  kind: string;
  title: string;
  content?: string;
  createdAt: string;
}

interface ThreadSpend {
  runs: number;
  active: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  posts: number;
}

interface TimelineResponse {
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

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

function num(payload: Record<string, unknown> | undefined, key: string): number {
  const v = payload?.[key];
  return typeof v === 'number' ? v : 0;
}

function str(payload: Record<string, unknown> | undefined, key: string): string {
  const v = payload?.[key];
  return typeof v === 'string' ? v : '';
}

function obj(payload: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const v = payload?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// fmtDur renders a span the way someone reading a timeline wants it: seconds
// with one decimal while sub-minute (so a 4.2s tool call is distinguishable
// from a 4.9s one), whole minutes above that.
function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m${String(rest).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// shortPath trims a long absolute path to its tail so the file name and its
// nearest folders stay readable in a chip.
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3).join('/')}`;
}

// ------------------------------------------------------------------ steps

// A Step is one rendered unit of the timeline. Tool steps absorb their result
// (the next tool_result for the same tool name); consecutive progress beats
// merge into one narration block; everything else is a system row.
type Step =
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

function systemLine(e: TimelineEvent): { text: string; tone?: 'ok' | 'bad' | 'muted' } | null {
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
function buildSteps(events: TimelineEvent[]): Step[] {
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

// ------------------------------------------------------------- tool render

type ToolFamily = 'shell' | 'edit' | 'write' | 'read' | 'search' | 'web' | 'ex' | 'other';

function toolFamily(name: string): ToolFamily {
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

function ToolIcon({ family }: { family: ToolFamily }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (family) {
    case 'shell':
      return <Terminal className={`${cls} text-emerald-600 dark:text-emerald-400`} aria-hidden="true" />;
    case 'edit':
      return <FilePen className={`${cls} text-amber-600 dark:text-amber-400`} aria-hidden="true" />;
    case 'write':
      return <FilePlus2 className={`${cls} text-amber-600 dark:text-amber-400`} aria-hidden="true" />;
    case 'read':
      return <FileCode2 className={`${cls} text-sky-600 dark:text-sky-400`} aria-hidden="true" />;
    case 'search':
      return <Search className={`${cls} text-sky-600 dark:text-sky-400`} aria-hidden="true" />;
    case 'web':
      return <Globe className={`${cls} text-violet-600 dark:text-violet-400`} aria-hidden="true" />;
    case 'ex':
      return <Plug className={`${cls} text-muted-foreground`} aria-hidden="true" />;
    default:
      return <Wrench className={`${cls} text-muted-foreground`} aria-hidden="true" />;
  }
}

// toolTitle is the one-line header of a tool step: verb + the interesting
// operand (file, command, API path) as a chip.
function toolTitle(step: Extract<Step, { kind: 'tool' }>): ReactNode {
  const input = step.input ?? {};
  const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const chip = (text: string, mono = true) => (
    <code className={`rounded bg-muted px-1 py-0.5 ${mono ? 'font-mono' : ''} text-[11px]`}>{text}</code>
  );
  switch (toolFamily(step.name)) {
    case 'shell': {
      const cmd = s('command').split('\n')[0];
      return (
        <>
          <span className="text-muted-foreground">ran</span> {cmd ? chip(cmd.length > 90 ? `${cmd.slice(0, 90)}…` : cmd) : step.detail}
        </>
      );
    }
    case 'edit':
      return (
        <>
          <span className="text-muted-foreground">edited</span> {chip(shortPath(s('file_path')) || 'file')}
        </>
      );
    case 'write':
      return (
        <>
          <span className="text-muted-foreground">wrote</span> {chip(shortPath(s('file_path') || s('notebook_path')) || 'file')}
        </>
      );
    case 'read':
      return (
        <>
          <span className="text-muted-foreground">read</span> {chip(shortPath(s('file_path')) || 'file')}
        </>
      );
    case 'search':
      return (
        <>
          <span className="text-muted-foreground">searched</span> {chip(s('pattern') || step.name)}
          {s('path') ? <span className="text-muted-foreground"> in {chip(shortPath(s('path')))}</span> : null}
        </>
      );
    case 'web':
      return (
        <>
          <span className="text-muted-foreground">{step.name === 'WebSearch' ? 'searched the web for' : 'fetched'}</span>{' '}
          {chip(s('query') || s('url') || step.detail, false)}
        </>
      );
    default:
      return <>{step.detail || <span className="font-mono">{step.name}</span>}</>;
  }
}

// DiffBlock renders an Edit's old → new strings as removed/added lines.
function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  return (
    <pre className="max-h-80 overflow-auto rounded-md border bg-background/70 font-mono text-[11px] leading-relaxed">
      {oldLines.map((l, i) => (
        <div key={`o-${i}`} className="whitespace-pre-wrap break-words bg-red-500/10 px-2 text-red-700 dark:text-red-300">
          <span className="select-none opacity-60">- </span>
          {l}
        </div>
      ))}
      {newLines.map((l, i) => (
        <div key={`n-${i}`} className="whitespace-pre-wrap break-words bg-emerald-500/10 px-2 text-emerald-700 dark:text-emerald-300">
          <span className="select-none opacity-60">+ </span>
          {l}
        </div>
      ))}
    </pre>
  );
}

function ToolBody({ step }: { step: Extract<Step, { kind: 'tool' }> }) {
  const input = step.input ?? {};
  const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const family = toolFamily(step.name);
  const result = step.result ? (
    <pre
      className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 font-mono text-[11px] leading-relaxed ${
        step.resultIsError ? 'border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300' : 'bg-background/70'
      }`}
    >
      {step.result}
    </pre>
  ) : null;
  switch (family) {
    case 'shell':
      return (
        <div className="space-y-1.5">
          {s('command') && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-100">
              <span className="select-none text-emerald-400">$ </span>
              {s('command')}
            </pre>
          )}
          {s('description') && <div className="text-[11px] text-muted-foreground">{s('description')}</div>}
          {result}
        </div>
      );
    case 'edit':
      return (
        <div className="space-y-1.5">
          <div className="font-mono text-[11px] text-muted-foreground">{s('file_path')}</div>
          <DiffBlock oldText={s('old_string')} newText={s('new_string')} />
          {step.resultIsError && result}
        </div>
      );
    case 'write':
      return (
        <div className="space-y-1.5">
          <div className="font-mono text-[11px] text-muted-foreground">{s('file_path') || s('notebook_path')}</div>
          {s('content') && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-emerald-500/5 p-2 font-mono text-[11px] leading-relaxed">
              {s('content')}
            </pre>
          )}
          {step.resultIsError && result}
        </div>
      );
    default:
      return (
        <div className="space-y-1.5">
          {step.detail && family !== 'read' && family !== 'search' && (
            <div className="text-[11px] text-muted-foreground">{step.detail}</div>
          )}
          {input.json ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background/70 p-2 font-mono text-[11px]">
              {String(input.json)}
            </pre>
          ) : null}
          {result}
        </div>
      );
  }
}

function ToolStep({ step, gapMs }: { step: Extract<Step, { kind: 'tool' }>; gapMs: number }) {
  const family = toolFamily(step.name);
  // Edits and writes are the point of a coding run — show them open. Reads,
  // searches and shell output stay folded behind a one-line result preview.
  const [open, setOpen] = useState(family === 'edit' || family === 'write' || !!step.resultIsError);
  const hasBody =
    !!step.result || !!step.input?.command || !!step.input?.old_string || !!step.input?.new_string || !!step.input?.content || !!step.input?.json;
  const preview = step.result ? step.result.replace(/\s+/g, ' ').slice(0, 110) : '';
  return (
    <li className="rounded-md border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`flex w-full items-start gap-2 px-2 py-1.5 text-left text-xs ${hasBody ? 'hover:bg-accent/40' : ''}`}
        aria-expanded={hasBody ? open : undefined}
      >
        <ChevronRight
          className={`mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''} ${hasBody ? '' : 'opacity-0'}`}
          aria-hidden="true"
        />
        <span className="mt-0.5">
          <ToolIcon family={family} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words leading-snug">{toolTitle(step)}</span>
          {!open && preview && (
            <span className={`block truncate text-[11px] ${step.resultIsError ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
              {step.resultIsError ? 'error: ' : '↳ '}
              {preview}
            </span>
          )}
        </span>
        <span className="shrink-0 pl-1 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {step.durationMs !== undefined && step.durationMs >= 500 ? `${fmtDur(step.durationMs)} · ` : ''}
          {gapMs >= 1000 ? <span className={gapMs >= 30_000 ? 'text-amber-600 dark:text-amber-500' : ''}>+{fmtDur(gapMs)} · </span> : null}
          {fmtTime(step.at)}
        </span>
      </button>
      {open && hasBody && (
        <div className="border-t border-border/60 px-2 py-2">
          <ToolBody step={step} />
        </div>
      )}
    </li>
  );
}

function StateBadge({ state }: { state: string }) {
  const cls =
    state === 'completed'
      ? 'bg-green-500/15 text-green-600 dark:text-green-400'
      : state === 'failed' || state === 'canceled'
        ? 'bg-red-500/15 text-red-600 dark:text-red-400'
        : 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {!TERMINAL.has(state) && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
      {state}
    </span>
  );
}

export function RunActivityDrawer() {
  const runID = useRunDrawerStore((s) => s.runID);
  const thread = useRunDrawerStore((s) => s.thread);
  const isOpen = !!runID || !!thread;
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);
  const [copiedArtifact, setCopiedArtifact] = useState<string | null>(null);
  const [showChatter, setShowChatter] = useState(false);
  // Resizable like the thread panel: drag the left edge, double-click to
  // reset, width persists across sessions.
  const { width: drawerWidth, handleProps: drawerHandleProps } = usePanelWidth(
    RUN_DRAWER_WIDTH,
    'left',
    'Resize run activity',
  );

  // dataUpdatedAt doubles as the wall clock for the live "elapsed" figure:
  // the poll refreshes it every 2.5s while the run is live, and reading it is
  // pure (no Date.now() in render).
  const { data, error, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['run-timeline', runID, thread?.parentID ?? null, thread?.rootID ?? null],
    queryFn: () => {
      /* istanbul ignore next -- the query is disabled unless runID or thread is set */
      const rid = runID ?? '';
      return apiFetch<TimelineResponse>(
        thread
          ? `/api/v1/runs/thread?parent=${encodeURIComponent(thread.parentID)}&root=${encodeURIComponent(thread.rootID)}`
          : `/api/v1/runs/${rid}`,
      );
    },
    enabled: isOpen,
    // Live runs keep growing their timeline; poll until terminal.
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.run.state) ? false : 2500,
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRunDrawer();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  const run = data?.run;
  const stopConversation = async () => {
    /* istanbul ignore if -- the Stop button renders only inside a run-gated block */
    if (!run) return;
    setStopping(true);
    try {
      await apiFetch(`/api/v1/runs/${run.id}/stop`, { method: 'POST', body: JSON.stringify({}) });
      await queryClient.invalidateQueries({ queryKey: ['run-timeline'] });
    } catch {
      // Already terminal or transient — the poll reconciles.
    } finally {
      setStopping(false);
    }
  };
  const name = (id: string) => data?.users[id] ?? id;
  const events = (data?.events ?? [])
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
  // Elapsed: wall clock from the first event to the last (or to now while the
  // run is live). Time parked on an approval prompt is a human waiting, not the
  // agent working, so it is subtracted out and reported separately — otherwise
  // a run that sat overnight on a gate reads as an eight-hour agent.
  const timing = (() => {
    if (!events.length) return null;
    const startMs = new Date(events[0].createdAt).getTime();
    const lastMs = new Date(events[events.length - 1].createdAt).getTime();
    /* istanbul ignore next -- events imply data implies run (refetchInterval dereferences it), and dataUpdatedAt > 0 whenever data exists */
    const endMs = TERMINAL.has(run?.state ?? '') ? lastMs : Math.max(lastMs, dataUpdatedAt || 0);
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
    return { totalMs, waitMs, workMs: Math.max(0, totalMs - waitMs) };
  })();
  const promptSplit = (() => {
    const p = events.find((e) => e.type === 'prompt');
    const firstUsage = events.find((e) => e.type === 'usage' && num(e.payload, 'inputTokens') > 0);
    if (!p || !firstUsage) return null;
    const ours = num(p.payload, 'oursTokensEst');
    const first = num(firstUsage.payload, 'inputTokens');
    if (ours <= 0 || first <= 0) return null;
    return { ours: Math.min(ours, first), harness: Math.max(0, first - ours) };
  })();

  // Thread mode interleaves the thread's messages with the work, by time —
  // the card marker reads as a label, not raw syntax.
  const messageSteps: Step[] = (data?.messages ?? []).map((m, i) => ({
    kind: 'message' as const,
    seq: 1_000_000_000 + i,
    at: m.createdAt,
    author: name(m.authorID),
    text: m.body.startsWith('[task:') ? '📌 Task card' : m.body,
  }));
  const steps = [...buildSteps(events), ...messageSteps]
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
    .filter((s) => showChatter || s.kind !== 'chatter');
  const toolCount = steps.filter((s) => s.kind === 'tool').length;
  const editCount = steps.filter((s) => s.kind === 'tool' && (toolFamily(s.name) === 'edit' || toolFamily(s.name) === 'write')).length;

  return (
    <div
      data-testid="run-activity-drawer"
      className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-xl"
      style={{ maxWidth: `${drawerWidth}px` }}
      role="dialog"
      aria-label="Agent run activity"
    >
      <PanelResizeHandle edge="left" testID="run-drawer-resize-handle" {...drawerHandleProps} />
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {run ? (
            <span>
              {name(run.agentID)}
              <span className="font-normal text-muted-foreground"> for {name(run.invokerID)}</span>
            </span>
          ) : (
            'Run activity'
          )}
        </div>
        <button
          type="button"
          aria-label="Close run activity"
          onClick={closeRunDrawer}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {error != null && (
          <div className="text-sm text-muted-foreground">
            Couldn’t load this run — it may be in a channel you don’t have access to.
          </div>
        )}
        {run && (
          <>
            {/* Config snapshot: what this run ACTUALLY executed under —
                mid-run pref edits never change it (plan-v2 §4). */}
            <div className="mb-3 space-y-1.5 rounded-lg border p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">State</span>
                <span className="flex items-center gap-1.5">
                  <StateBadge state={run.state} />
                  {!TERMINAL.has(run.state) && (
                    // The human brake: cancels EVERY live run in this
                    // conversation thread and drops queued handoffs.
                    <button
                      type="button"
                      disabled={stopping}
                      onClick={() => void stopConversation()}
                      className="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                      title="Stop this conversation (all agents, this thread)"
                    >
                      <Square className="h-3 w-3" aria-hidden="true" />
                      Stop
                    </button>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Harness</span>
                <span className="font-mono">
                  {run.harness}
                  {run.model ? ` · ${run.model}` : ''}
                </span>
              </div>
              {typeof run.round === 'number' && run.round > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Chain round</span>
                  <span>{run.round}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">This turn</span>
                <span>
                  {run.spend.turns} turns · {(run.spend.inputTokens + run.spend.outputTokens).toLocaleString()} tokens ·{' '}
                  {run.spend.posts} posts
                  {toolCount > 0 ? ` · ${toolCount} tool calls${editCount ? ` (${editCount} edits)` : ''}` : ''}
                </span>
              </div>
              {timing && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Elapsed</span>
                  <span>
                    {fmtDur(timing.totalMs)}
                    {timing.waitMs >= 1000 && (
                      <span className="text-muted-foreground">
                        {' '}
                        ({fmtDur(timing.workMs)} working · {fmtDur(timing.waitMs)} awaiting approval)
                      </span>
                    )}
                  </span>
                </div>
              )}
              {promptSplit && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">First turn</span>
                  <span>
                    Ex ≈{promptSplit.ours.toLocaleString()} · harness ≈{promptSplit.harness.toLocaleString()} tokens
                  </span>
                </div>
              )}
              {data?.threadSpend && data.threadSpend.runs > 1 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Conversation</span>
                  <span>
                    {data.threadSpend.runs} turns ·{' '}
                    {(data.threadSpend.inputTokens + data.threadSpend.outputTokens).toLocaleString()} tokens ·{' '}
                    {data.threadSpend.posts} posts
                    {data.threadSpend.active > 0 ? ` · ${data.threadSpend.active} active` : ''}
                  </span>
                </div>
              )}
              {run.failReason && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Reason</span>
                  <span className="font-mono">{run.failReason}</span>
                </div>
              )}
            </div>

            {(data?.artifacts?.filter((a) => a.kind !== 'api_response').length ?? 0) > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  Artifacts
                </div>
                <div className="space-y-1.5">
                  {data?.artifacts?.filter((a) => a.kind !== 'api_response').map((a) => (
                    // A single artifact opens expanded — it's usually why the
                    // drawer was opened at all.
                    <details
                      key={a.id}
                      open={data?.artifacts?.length === 1}
                      className="group rounded-lg border"
                    >
                      <summary className="flex cursor-pointer select-none items-center gap-2 px-2.5 py-2 text-xs hover:bg-accent/50">
                        <ChevronRight
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{a.title}</span>
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {a.kind}
                        </span>
                        <button
                          type="button"
                          title="Copy artifact content"
                          onClick={(e) => {
                            e.preventDefault();
                            void navigator.clipboard.writeText(a.content ?? '');
                            setCopiedArtifact(a.id);
                            setTimeout(() => setCopiedArtifact(null), 1500);
                          }}
                          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {copiedArtifact === a.id ? (
                            <Check className="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                        </button>
                      </summary>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
                        {a.content ?? ''}
                      </pre>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {/* Raw API responses (auto-captured connector_call bodies): the
                audit trail for "did the agent skip something?". Collapsed by
                default; each row expands to the full stored body. */}
            {(data?.artifacts?.filter((a) => a.kind === 'api_response').length ?? 0) > 0 && (
              <details className="mb-3 rounded-lg border">
                <summary className="cursor-pointer select-none px-2.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-accent/50">
                  API responses (raw) —{' '}
                  {data?.artifacts?.filter((a) => a.kind === 'api_response').length} calls
                </summary>
                <div className="space-y-1 border-t p-1.5">
                  {data?.artifacts
                    ?.filter((a) => a.kind === 'api_response')
                    .map((a) => (
                      <details key={a.id} className="rounded-md border">
                        <summary className="cursor-pointer select-none truncate px-2 py-1.5 font-mono text-[11px] hover:bg-accent/50">
                          {a.title}
                        </summary>
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
                          {a.content ?? ''}
                        </pre>
                      </details>
                    ))}
                </div>
              </details>
            )}

            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">Activity</span>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <input type="checkbox" className="h-3 w-3" checked={showChatter} onChange={(e) => setShowChatter(e.target.checked)} />
                show harness turns &amp; tokens
              </label>
            </div>

            {/* The timeline: tool steps with icon + operand + expandable body,
                the model's narration as speech, approvals in amber, lifecycle
                rows small. Each step carries its time and the gap since the
                previous one — events land when work COMPLETES, so a big gap
                is a slow step. */}
            <ol className="space-y-1.5" aria-label="Run timeline">
              {steps.map((s, i) => {
                const prev = steps[i - 1];
                const gapMs = prev ? Math.max(0, new Date(s.at).getTime() - new Date(prev.at).getTime()) : 0;
                const stamp = (
                  <span className="shrink-0 pl-1 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                    {gapMs >= 1000 ? <span className={gapMs >= 30_000 ? 'text-amber-600 dark:text-amber-500' : ''}>+{fmtDur(gapMs)} · </span> : null}
                    {fmtTime(s.at)}
                  </span>
                );
                switch (s.kind) {
                  case 'tool':
                    return <ToolStep key={s.seq} step={s} gapMs={gapMs} />;
                  case 'narration':
                    return (
                      <li key={s.seq} className="flex items-start gap-2 rounded-md border border-border/50 bg-background px-2 py-1.5">
                        <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-snug">{s.text}</span>
                        {stamp}
                      </li>
                    );
                  case 'approval': {
                    const tone =
                      s.state === 'asked'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                        : s.state === 'approved'
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                          : 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200';
                    return (
                      <li key={s.seq} className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${tone}`}>
                        {s.state === 'asked' ? (
                          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        ) : s.state === 'approved' ? (
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        ) : (
                          <X className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1 break-words leading-snug">
                          {s.state === 'asked' ? 'Asked for approval — ' : ''}
                          {s.text}
                        </span>
                        {stamp}
                      </li>
                    );
                  }
                  case 'message':
                    return (
                      <li key={s.seq} className="flex items-start gap-2 rounded-md border-l-2 border-primary/50 bg-primary/5 px-2 py-1.5">
                        <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                        <span className="min-w-0 flex-1 text-xs leading-snug">
                          <span className="font-medium">{s.author}</span>{' '}
                          <span className="whitespace-pre-wrap break-words text-foreground/90">{s.text}</span>
                        </span>
                        {stamp}
                      </li>
                    );
                  case 'chatter':
                    return (
                      <li key={s.seq} className="flex items-start gap-2 px-2 text-[11px] leading-snug text-muted-foreground">
                        <span className="min-w-0 flex-1">{s.text}</span>
                        {stamp}
                      </li>
                    );
                  default:
                    return (
                      <li
                        key={s.seq}
                        className={`flex items-start gap-2 px-2 text-xs leading-snug ${
                          s.tone === 'bad'
                            ? 'text-red-600 dark:text-red-400'
                            : s.tone === 'ok'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : s.tone === 'muted'
                                ? 'text-muted-foreground'
                                : ''
                        }`}
                      >
                        <span className="min-w-0 flex-1 break-words">{s.text}</span>
                        {stamp}
                      </li>
                    );
                }
              })}
            </ol>
            {!TERMINAL.has(run.state) && (
              <div className="mt-2 flex items-center gap-2 px-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                working…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
