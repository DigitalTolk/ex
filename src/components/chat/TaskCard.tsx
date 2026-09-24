import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, GitMerge, Loader2, Ticket, Wrench } from 'lucide-react';
import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { taskKindFlair, taskStateLabel, taskStateTerminal, type TaskMarker } from '@/lib/task-marker';

// TaskCard: the inline chat rendering of a coding-task card marker (see
// lib/task-marker.ts) — the thread root of a coding task. The marker carries
// enough to paint the card instantly (flair, title, state, project); live
// details (repos + their MRs, the test plan, sign-off, who the requester is)
// come from the task endpoint.

interface TaskRepo {
  path: string;
  role: string;
  branch: string;
  baseBranch?: string;
  mrURL?: string;
  changed?: boolean;
}

interface TestPlan {
  url?: string;
  steps: string[];
  counterSteps?: string[];
  accounts?: string;
  notes?: string;
}

interface CodingTask {
  id: string;
  projectKey: string;
  projectName: string;
  title: string;
  goal: string;
  kind: string;
  state: string;
  steering?: string;
  channelID: string;
  threadRootID: string;
  requesterID: string;
  repos: TaskRepo[];
  ticket?: { connector: string; id: string; url?: string } | null;
  testPlan?: TestPlan | null;
  signedOffAt?: string | null;
}

interface TaskResponse {
  task: CodingTask;
  url?: string;
}

function stateTone(state: string): string {
  switch (state) {
    case 'awaiting_user_test':
      return 'border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'mr_created':
      return 'border-sky-500/60 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    case 'done':
      return 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'setup_failed':
      return 'border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-300';
    case 'abandoned':
      return 'border-muted-foreground/40 bg-muted text-muted-foreground';
    default:
      return 'border-border bg-muted/60 text-foreground';
  }
}

function kindTone(kind: string): string {
  switch (kind) {
    case 'feature':
      return 'border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300';
    case 'chore':
      return 'border-muted-foreground/40 bg-muted text-muted-foreground';
    default:
      return 'border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-300';
  }
}

// Descriptions longer than this fold to four lines with a "Show more".
const GOAL_FOLD_CHARS = 420;

function repoName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function TaskCard({ marker, currentUserId }: { marker: TaskMarker; currentUserId?: string }) {
  const queryClient = useQueryClient();
  const terminal = taskStateTerminal(marker.state);
  // The test plan matters most while the requester is testing — open then,
  // folded otherwise. The description is always shown (long ones fold).
  const [planOpen, setPlanOpen] = useState(marker.state === 'awaiting_user_test');
  const [goalOpen, setGoalOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['coding-task', marker.id],
    queryFn: () => apiFetch<TaskResponse>(`/api/v1/coding-tasks/${marker.id}`),
    // The marker is rewritten on every state change (message.edited), so the
    // card repaints anyway; the poll only freshens links/sign-off while live.
    refetchInterval: terminal ? false : 30_000,
    staleTime: 10_000,
  });
  const task = data?.task;
  const isRequester = !!task && !!currentUserId && task.requesterID === currentUserId;
  const state = task?.state ?? marker.state;
  const flair = taskKindFlair(task?.kind ?? marker.kind);
  // Tasks recorded before repos/test plans existed come back with null
  // fields — render them as empty rather than crashing the channel.
  const repos: TaskRepo[] = Array.isArray(task?.repos) ? task.repos : [];
  const plan: TestPlan | null =
    task?.testPlan && Array.isArray(task.testPlan.steps) ? task.testPlan : null;

  const signOff = useMutation({
    mutationFn: () => apiFetch<TaskResponse>(`/api/v1/coding-tasks/${marker.id}/signoff`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['coding-task', marker.id] }),
  });
  const steering = useMutation({
    mutationFn: (mode: 'requester' | 'anyone') =>
      apiFetch<TaskResponse>(`/api/v1/coding-tasks/${marker.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ steering: mode }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['coding-task', marker.id] }),
  });
  // Manual end of a task: "done" once its MRs are open (frees the project
  // for the next task), "abandoned" to drop the work at any other point.
  const closeTask = useMutation({
    mutationFn: (to: 'done' | 'abandoned') =>
      apiFetch<TaskResponse>(`/api/v1/coding-tasks/${marker.id}/close`, {
        method: 'POST',
        body: JSON.stringify({ state: to }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['coding-task', marker.id] }),
  });

  const canSignOff = isRequester && state === 'awaiting_user_test' && !task?.signedOffAt;
  const mrCount = repos.filter((r) => r.mrURL).length;

  return (
    <div
      data-testid="task-card"
      className="my-0.5 w-full overflow-hidden rounded-lg border bg-muted/30"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${kindTone(task?.kind ?? marker.kind)}`}
          title={`Task kind: ${flair.label}`}
        >
          <span aria-hidden="true">{flair.emoji}</span>
          {flair.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{task?.title ?? marker.title}</span>
        {task?.ticket?.id &&
          (task.ticket.url ? (
            <a
              href={task.ticket.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] text-foreground hover:bg-accent"
              title={`Open ${task.ticket.id} in ${task.ticket.connector || 'the ticket system'}`}
              data-testid="task-ticket"
            >
              <Ticket className="h-3 w-3" aria-hidden="true" />
              {task.ticket.id}
              <ExternalLink className="h-2.5 w-2.5 opacity-70" aria-hidden="true" />
            </a>
          ) : (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              title={`Ticket ${task.ticket.id}${task.ticket.connector ? ` (${task.ticket.connector})` : ''}`}
              data-testid="task-ticket"
            >
              <Ticket className="h-3 w-3" aria-hidden="true" />
              {task.ticket.id}
            </span>
          ))}
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[11px] ${stateTone(state)}`}
          data-testid="task-state"
        >
          {taskStateLabel(state)}
        </span>
      </div>

      {/* The task itself — what was asked — comes first and reads as prose.
          Long descriptions fold after a few lines. */}
      {task?.goal && (
        <div className="border-t px-3 py-2 text-sm leading-relaxed" data-testid="task-goal">
          <div className={`whitespace-pre-wrap break-words ${goalOpen || task.goal.length <= GOAL_FOLD_CHARS ? '' : 'line-clamp-4'}`}>
            {task.goal}
          </div>
          {task.goal.length > GOAL_FOLD_CHARS && (
            <button
              type="button"
              onClick={() => setGoalOpen((v) => !v)}
              className="mt-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {goalOpen ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Project + repos: one chip per repo, its MR when opened. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 text-foreground">
          <Wrench className="h-3 w-3" aria-hidden="true" />
          {task?.projectName || marker.project}
        </span>
        {repos.map((r) => (
          <span key={r.path} className="inline-flex items-center gap-1" title={`${r.path} · branch ${r.branch}`}>
            <span className="rounded bg-muted px-1 py-0.5">
              {repoName(r.path)}
              <span className="opacity-60"> · {r.role}</span>
            </span>
            {r.mrURL && (
              <a
                href={r.mrURL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-foreground underline-offset-2 hover:underline"
                title={`Merge request for ${repoName(r.path)}`}
              >
                <GitMerge className="h-3 w-3" aria-hidden="true" />
                MR
              </a>
            )}
          </span>
        ))}
        {plan?.url && (
          <a
            href={plan.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
            title={isRequester ? 'Open the product to test (served from your machine)' : "Served from the requester's machine — may not open for you"}
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            open &amp; test
          </a>
        )}
      </div>

      {/* The test plan: steps from the requester's perspective + counter-checks. */}
      {plan && plan.steps.length > 0 && (
        <div className="border-t px-3 py-1.5 text-xs">
          <button
            type="button"
            onClick={() => setPlanOpen((v) => !v)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            aria-expanded={planOpen}
          >
            {planOpen ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
            How to test — {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
            {plan.counterSteps?.length ? ` · ${plan.counterSteps.length} must-not check${plan.counterSteps.length === 1 ? '' : 's'}` : ''}
          </button>
          {planOpen && (
            <div className="mt-1.5 space-y-1.5">
              {plan.accounts && <div className="text-muted-foreground">Use: {plan.accounts}</div>}
              <ol className="list-decimal space-y-0.5 pl-5">
                {plan.steps.map((s, i) => (
                  <li key={`s-${i}`}>{s}</li>
                ))}
              </ol>
              {plan.counterSteps && plan.counterSteps.length > 0 && (
                <>
                  <div className="font-medium text-muted-foreground">Should NOT work / must stay as before</div>
                  <ul className="list-disc space-y-0.5 pl-5">
                    {plan.counterSteps.map((s, i) => (
                      <li key={`c-${i}`}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.notes && <div className="text-muted-foreground">{plan.notes}</div>}
            </div>
          )}
        </div>
      )}

      {isRequester && !terminal && (
        <div className="flex flex-wrap items-center gap-3 border-t px-3 py-2 text-xs">
          {canSignOff && (
            <button
              type="button"
              onClick={() => signOff.mutate()}
              disabled={signOff.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
              data-testid="task-signoff"
            >
              {signOff.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Looks good — create MR{repos.length > 1 ? 's' : ''}
            </button>
          )}
          {task?.signedOffAt && state === 'awaiting_user_test' && (
            <span className="text-muted-foreground">Signed off — opening the merge request{mrCount > 1 ? 's' : ''}…</span>
          )}
          {state === 'mr_created' && (
            <button
              type="button"
              onClick={() => closeTask.mutate('done')}
              disabled={closeTask.isPending}
              title="The merge requests stay open on GitLab; this frees the project for its next task"
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium hover:bg-accent disabled:opacity-60"
              data-testid="task-close"
            >
              Close task
            </button>
          )}
          {state !== 'mr_created' && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Abandon this task? dev stops working on it; the branch stays on your machine.')) {
                  closeTask.mutate('abandoned');
                }
              }}
              disabled={closeTask.isPending}
              className="inline-flex items-center rounded-md px-2 py-1 text-muted-foreground hover:text-destructive disabled:opacity-60"
              data-testid="task-abandon"
            >
              Abandon
            </button>
          )}
          <label className="ml-auto inline-flex items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={task?.steering === 'anyone'}
              disabled={steering.isPending}
              onChange={(e) => steering.mutate(e.target.checked ? 'anyone' : 'requester')}
            />
            Anyone in channel may steer
          </label>
          {(signOff.error || steering.error || closeTask.error) && (
            <span className="text-destructive">
              {String(((signOff.error ?? steering.error ?? closeTask.error) as Error)?.message ?? 'Something went wrong')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
