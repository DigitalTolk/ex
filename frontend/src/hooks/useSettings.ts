import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { WorkspaceSettings } from '@/types';

export function useWorkspaceSettings() {
  return useQuery({
    queryKey: ['workspace-settings'],
    queryFn: () => apiFetch<WorkspaceSettings>('/api/v1/admin/settings'),
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
      qc.setQueryData(['workspace-settings'], data);
    },
  });
}
