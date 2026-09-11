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
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanelResizeHandle } from '@/components/layout/PanelResizeHandle';
import { usePanelWidth } from '@/hooks/usePanelWidth';
import { ApiError, apiFetch } from '@/lib/api';
import { RUN_DRAWER_WIDTH } from '@/lib/panel-width';
import { closeRunDrawer, useRunDrawerStore } from '@/stores/run-drawer';
import {
  TERMINAL,
  buildTimeline,
  fmtDur,
  fmtTime,
  shortPath,
  toolFamily,
  type Step,
  type TimelineResponse,
  type ToolFamily,
} from '@/lib/run-timeline';

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

// ------------------------------------------------------------- tool render

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
  // Edits and writes are the point of a coding run — show them open, and so is
  // anything that ERRORED. Derived rather than seeded into state: a tool's
  // result arrives in a later event, so a step that mounts pending and fails a
  // second later used to stay folded. An explicit toggle wins from then on.
  const autoOpen = family === 'edit' || family === 'write' || !!step.resultIsError;
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? autoOpen;
  const hasBody =
    !!step.result || !!step.input?.command || !!step.input?.old_string || !!step.input?.new_string || !!step.input?.content || !!step.input?.json;
  const preview = step.result ? step.result.replace(/\s+/g, ' ').slice(0, 110) : '';
  return (
    <li className="rounded-md border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => hasBody && setToggled(!open)}
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

// EMPTY_USERS is a stable identity so the memo below doesn't re-run on every
// render while the query is still loading.
const EMPTY_USERS: Record<string, string> = {};

export function RunActivityDrawer() {
  const runID = useRunDrawerStore((s) => s.runID);
  const thread = useRunDrawerStore((s) => s.thread);
  const isOpen = !!runID || !!thread;
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);
  const [copiedArtifact, setCopiedArtifact] = useState<string | null>(null);
  // The "copied ✓" flash timer, cleared on unmount: closing the drawer within
  // its window used to leave a setState firing at a gone component.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
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

  // ONE memo for the whole derived timeline. Every figure below (elapsed,
  // prompt split, steps, counts) is a fold over the event list, and it used to
  // be recomputed on every render — once per pointermove while the panel was
  // being dragged, and again on each 2.5s poll of a long task timeline.
  // One name lookup for the whole component. Computed unconditionally so the
  // "no data yet" shape is the same object shape as the loaded one — the
  // alternative (`data?.users[id]` at each call site) put an unreachable
  // optional-chain branch in a helper only ever called with data present.
  const users = data?.users ?? EMPTY_USERS;
  const timeline = useMemo(
    () =>
      buildTimeline(data, {
        showChatter,
        /* istanbul ignore next -- dataUpdatedAt is > 0 whenever data exists */
        nowMs: dataUpdatedAt || 0,
        authorName: (id) => users[id] ?? id,
      }),
    [data, users, showChatter, dataUpdatedAt],
  );

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
  const name = (id: string) => users[id] ?? id;
  const { timing, promptSplit, steps, toolCount, editCount } = timeline;

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
            {/* A thread with replies but no agent runs answers 404 — that is
                "nothing to show", not "you can't see this". The generic copy
                read as an access error on ordinary human threads. */}
            {error instanceof ApiError && error.status === 404
              ? thread
                ? 'No agent has worked in this thread yet.'
                : 'That run no longer exists.'
              : error instanceof ApiError && error.status === 403
                ? 'Only the person who invoked a run can see its activity.'
                : 'Couldn’t load this run — it may be in a channel you don’t have access to.'}
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
                            clearTimeout(copiedTimer.current);
                            copiedTimer.current = setTimeout(() => setCopiedArtifact(null), 1500);
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
