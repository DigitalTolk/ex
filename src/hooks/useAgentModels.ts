import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useWorkspaceSettings } from '@/hooks/useSettings';
import type { AgentModelOption, WorkspaceSettings } from '@/types';

// Engines whose model is picked from the admin's list; Codex keeps free text.
export function harnessHasModelList(harness: string): boolean {
  return harness === 'claude' || harness === 'bedrock';
}

const NO_MODELS: AgentModelOption[] = [];

// useAgentModels is the admin's list of models agents may run on (every
// engine), from the workspace settings: it refreshes when an admin changes it
// (settings.updated).
export function useAgentModels(): AgentModelOption[] {
  return useWorkspaceSettings().data?.agentModels ?? NO_MODELS;
}

// useSetAgentModels saves the whole list. Admin-only on the server, which
// checks every id and answers with the settings as saved.
export function useSetAgentModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (models: AgentModelOption[]) =>
      apiFetch<WorkspaceSettings>('/api/v1/admin/agent-models', {
        method: 'PUT',
        body: JSON.stringify({ models }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.workspaceSettings(), data);
    },
  });
}
