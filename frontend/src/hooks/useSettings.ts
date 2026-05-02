import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { WorkspaceSettings } from '@/types';

const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  maxUploadBytes: 0,
  allowedExtensions: [],
  giphyEnabled: false,
};

export function useWorkspaceSettings(enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaceSettings(),
    queryFn: async () =>
      (await apiFetch<WorkspaceSettings>('/api/v1/admin/settings')) ?? DEFAULT_WORKSPACE_SETTINGS,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpdateWorkspaceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkspaceSettings) =>
      apiFetch<WorkspaceSettings>('/api/v1/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.workspaceSettings(), data);
    },
  });
}
