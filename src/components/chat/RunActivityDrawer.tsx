import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ChevronRight, Copy, FileText, Loader2, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
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

// eventRow renders one timeline row. `minor` rows are harness chatter (turns,
// token ticks, progress snippets) shown small and muted; everything else —
// tool calls with their detail ("cliffhub API: GET api/leave/requests…"),
// approvals, attachments, state transitions — is a primary row.
interface EventRow {
  text: string;
  minor?: boolean;
}

function eventRow(e: TimelineEvent): EventRow | null {
  const line = eventLine(e);
  if (line === null) return null;
  // Results of chatty internal tools (state ticks, thread re-reads) stay
  // minor; data-bearing results (API responses, command output) show full.
  const name = str(e.payload, 'name');
  const minorResult =
    e.type === 'tool_result' &&
    (name === 'mcp__ex__set_state' || name === 'mcp__ex__get_thread' || name === 'ToolSearch');
  const minor =
    e.type === 'turn' || e.type === 'usage' || e.type === 'progress' || e.type === 'state' || minorResult;
  return { text: line, minor };
}

// eventLine renders one timeline row as a compact human-readable label.
// Unknown event types fall back to their raw type so nothing is invisible.
function eventLine(e: TimelineEvent): string | null {
  switch (e.type) {
    case 'run.invoked':
      return 'Run invoked';
    case 'run.acknowledged':
      return 'Claimed by the runner';
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
      return `Context assembled — ${parts.join(', ')}${dropped > 0 ? ` (${dropped} trimmed for budget)` : ''}`;
    }
    case 'turn':
      return 'Harness turn';
    case 'usage': {
      const inTok = num(e.payload, 'inputTokens');
      const outTok = num(e.payload, 'outputTokens');
      return `Tokens — ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out`;
    }
    case 'progress': {
      const text = str(e.payload, 'text').replace(/\s+/g, ' ').trim();
      return text ? `“${text.slice(0, 160)}${text.length > 160 ? '…' : ''}”` : null;
    }
    case 'tool': {
      const name = str(e.payload, 'name').replace(/^mcp__ex__/, '');
      // detail says what the call actually does — the API hit, the command
      // run, the file read — not just which tool fired.
      const detail = str(e.payload, 'detail');
      return detail || `Tool: ${name || 'unknown'}`;
    }
    case 'tool_result': {
      // What the call RETURNED — size + snippet, straight from the runner.
      const detail = str(e.payload, 'detail');
      return detail ? `↳ ${detail}` : null;
    }
    case 'prompt': {
      // What EX injected vs what the harness adds on top — rendered here and
      // split against turn 1 in the header.
      const est = num(e.payload, 'oursTokensEst');
      const rules = num(e.payload, 'rulesChars');
      const task = num(e.payload, 'taskChars');
      const resumed = e.payload?.['resumed'] === true;
      return `Ex prompt — ≈${est.toLocaleString()} tokens (rules ${(rules / 1024).toFixed(1)}KB, task+context ${(task / 1024).toFixed(1)}KB${resumed ? ', warm resume delta' : ''}); the rest of turn 1 is harness overhead`;
    }
    case 'connector.attached':
      return `Attached connector ${str(e.payload, 'slug')} — ${str(e.payload, 'reason')}`;
    case 'watch.delivered':
      return 'Watcher result delivered';
    case 'watch.skipped':
      return 'Watcher decided nothing matched (no delivery)';
    case 'state':
      return `State ${str(e.payload, 'state')}`;
    case 'context.written':
      return 'Saved an item to shared context';
    case 'approval.requested':
      return `Asked for approval — ${str(e.payload, 'summary')}`;
    case 'approval.decided': {
      const choice = str(e.payload, 'choice');
      return `Approval ${str(e.payload, 'state')}${choice ? ` — chose “${choice}”` : ''}`;
    }
    case 'approval.expired':
      return 'Approval expired undecided (counts as denied)';
    case 'artifact.created':
      return `Published artifact “${str(e.payload, 'title')}”`;
    case 'skill.invoked':
      return `Used skill “${str(e.payload, 'name')}”`;
    case 'run.queued_offline':
      return 'Queued — waiting for the desktop app to come online';
    case 'run.canceled':
      return 'Stopped by a human';
    case 'run.completed':
      return 'Completed';
    case 'run.failed':
      return `Failed — ${str(e.payload, 'reason') || 'unknown reason'}`;
    default:
      return e.type;
  }
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

// groupEvents buckets consecutive events sharing the same wall-clock second
// under one timestamp header. Each group also carries how long it waited on
// the previous one (gapMs) and its offset from the run's first event (atMs) —
// events land when work COMPLETES, so the gap before a row is how long that
// step took, which is what makes a slow step findable by eye.
interface EventGroup {
  key: string;
  time: string;
  gapMs: number;
  atMs: number;
  rows: { seq: number; text: string; minor?: boolean }[];
}

function groupEvents(events: TimelineEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let startMs = 0;
  let prevMs = 0;
  for (const e of events) {
    const row = eventRow(e);
    if (!row) continue;
    const at = new Date(e.createdAt);
    const ms = at.getTime();
    const time = at.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const last = groups[groups.length - 1];
    if (last && last.time === time) {
      last.rows.push({ seq: e.seq, ...row });
      continue;
    }
    if (!groups.length) {
      startMs = ms;
      prevMs = ms;
    }
    groups.push({
      key: `${time}-${e.seq}`,
      time,
      gapMs: ms - prevMs,
      atMs: ms - startMs,
      rows: [{ seq: e.seq, ...row }],
    });
    prevMs = ms;
  }
  return groups;
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
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);
  const [copiedArtifact, setCopiedArtifact] = useState<string | null>(null);
  // Resizable like the thread panel: drag the left edge, double-click to
  // reset, width persists across sessions.
  const { width: drawerWidth, handleProps: drawerHandleProps } = usePanelWidth(
    RUN_DRAWER_WIDTH,
    'left',
    'Resize run activity',
  );

  const { data, error, isLoading } = useQuery({
    queryKey: ['run-timeline', runID],
    queryFn: () => apiFetch<TimelineResponse>(`/api/v1/runs/${runID ?? ''}`),
    enabled: !!runID,
    // Live runs keep growing their timeline; poll until terminal.
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.run.state) ? false : 2500,
  });

  useEffect(() => {
    if (!runID) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRunDrawer();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [runID]);

  if (!runID) return null;

  const run = data?.run;
  const stopConversation = async () => {
    if (!run) return;
    setStopping(true);
    try {
      await apiFetch(`/api/v1/runs/${run.id}/stop`, { method: 'POST', body: JSON.stringify({}) });
      await queryClient.invalidateQueries({ queryKey: ['run-timeline', runID] });
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
  // Ours-vs-harness split of the first turn: the runner reports what Ex
  // injected (the 'prompt' event); everything above it in turn 1 is the
  // harness's own system prompt + tool machinery (cache-state dependent).
  // Elapsed: wall clock from the first event to the last (or to now while the
  // run is live). Time parked on an approval prompt is a human waiting, not the
  // agent working, so it is subtracted out and reported separately — otherwise
  // a run that sat overnight on a gate reads as an eight-hour agent.
  const timing = (() => {
    if (!events.length) return null;
    const startMs = new Date(events[0].createdAt).getTime();
    const endMs = TERMINAL.has(run?.state ?? '')
      ? new Date(events[events.length - 1].createdAt).getTime()
      : Date.now();
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

            {/* Timeline: events grouped under one small timestamp per second
                (a burst of tool calls reads as one moment, not a wall of
                repeated clocks). Meaningful rows — API calls, commands,
                approvals — render full-size; harness chatter stays small. */}
            <ol className="space-y-2" aria-label="Run timeline">
              {groupEvents(events).map((g) => (
                <li key={g.key}>
                  <div className="mb-0.5 flex items-baseline gap-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/70">
                    <span>{g.time}</span>
                    {/* +gap = how long this step took; at = offset into the run.
                        Sub-second gaps are noise, so they stay unlabelled. */}
                    {g.gapMs >= 1000 && (
                      <span
                        className={g.gapMs >= 30_000 ? 'text-amber-600 dark:text-amber-500' : undefined}
                        title={`${fmtDur(g.atMs)} into the run`}
                      >
                        +{fmtDur(g.gapMs)}
                      </span>
                    )}
                  </div>
                  <ol className="space-y-0.5 border-l border-border/60 pl-2.5">
                    {g.rows.map((r) => (
                      <li
                        key={r.seq}
                        className={
                          r.minor
                            ? 'break-words text-[11px] leading-snug text-muted-foreground'
                            : 'break-words text-sm leading-snug'
                        }
                      >
                        {r.text}
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
