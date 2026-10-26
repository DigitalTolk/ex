import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

// A coding task as served by /api/v1/coding-tasks/{id} — the live details
// behind a task card marker (lib/task-marker.ts).
export interface TaskRepo {
  path: string;
  role: string;
  branch: string;
  baseBranch?: string;
  mrURL?: string;
  changed?: boolean;
}

export interface TestPlan {
  url?: string;
  steps: string[];
  counterSteps?: string[];
  accounts?: string;
  notes?: string;
}

export interface CodingTask {
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

export interface TaskResponse {
  task: CodingTask;
  url?: string;
}

// The task behind a card. The marker is rewritten on every state change
// (message.edited), so the card repaints anyway; the poll only freshens
// links/sign-off while the task is still live.
export function useCodingTask(id: string, terminal: boolean) {
  return useQuery({
    queryKey: queryKeys.codingTask(id),
    queryFn: () => apiFetch<TaskResponse>(`/api/v1/coding-tasks/${id}`),
    refetchInterval: terminal ? false : 30_000,
    staleTime: 10_000,
  });
}

// The requester's actions on a task: sign off the test, choose who may steer
// it, and end it by hand — "done" once its MRs are open (frees the project
// for the next task), "abandoned" to drop the work at any other point.
export function useCodingTaskActions(id: string) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.codingTask(id) });
  const signOff = useMutation({
    mutationFn: () => apiFetch<TaskResponse>(`/api/v1/coding-tasks/${id}/signoff`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const steering = useMutation({
    mutationFn: (mode: 'requester' | 'anyone') =>
      apiFetch<TaskResponse>(`/api/v1/coding-tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ steering: mode }),
      }),
    onSuccess: refresh,
  });
  const closeTask = useMutation({
    mutationFn: (to: 'done' | 'abandoned') =>
      apiFetch<TaskResponse>(`/api/v1/coding-tasks/${id}/close`, {
        method: 'POST',
        body: JSON.stringify({ state: to }),
      }),
    onSuccess: refresh,
  });
  return { signOff, steering, closeTask };
}
