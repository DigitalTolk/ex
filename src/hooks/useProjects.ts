import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { CodingProject, ProjectLink, ProjectRepo, ProjectScreen } from '@/types/generated';

// Projects page data (plan-projects-design.md): products with their design
// references — app link, notes, links, repos and labelled screenshots the
// design agent copies from. Every change publishes project.changed, which
// ChatPage turns into an invalidation of queryKeys.projects(), so open pages
// on other devices stay current.

export interface ProjectSummary extends CodingProject {
  screenCount: number;
  oldestScreenAt?: string;
}

export interface ScreenView extends ProjectScreen {
  imageURL?: string;
  thumbnailURL?: string;
  width?: number;
  height?: number;
}

export interface ProjectDetail {
  project: CodingProject;
  screens: ScreenView[];
  canManage: boolean;
  // The uploaded stylesheet as the agent sees it (never the raw file).
  theme?: ThemeView;
}

export interface ThemeView {
  filename: string;
  size: number;
  variables: number;
  summary: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ProjectPatch {
  name?: string;
  appURL?: string;
  description?: string;
  designNotes?: string;
  links?: ProjectLink[];
  repos?: ProjectRepo[];
  uiLibrary?: string;
  // The project's main stylesheet ('' removes it) and its file name.
  themeCSS?: string;
  themeFilename?: string;
}

export interface ScreenPatch {
  page?: string;
  description?: string;
  viewport?: 'desktop' | 'mobile';
  state?: string;
  seenBy?: string;
  route?: string;
  attachmentID?: string;
}

export function useProjects(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => {
      const res = await apiFetch<{ projects: ProjectSummary[] }>('/api/v1/projects');
      return res.projects ?? [];
    },
    enabled: opts.enabled ?? true,
  });
}

export function useProject(key: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(key ?? ''),
    queryFn: async () => {
      const res = await apiFetch<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(key!)}`);
      return { ...res, screens: res.screens ?? [] };
    },
    enabled: !!key,
  });
}

function useInvalidateProjects() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
}

export function useCreateProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (body: ProjectPatch & { name: string }) =>
      apiFetch<{ project: CodingProject }>('/api/v1/projects', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

export function useUpdateProject(key: string) {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (patch: ProjectPatch) =>
      apiFetch<{ project: CodingProject }>(`/api/v1/projects/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (key: string) => apiFetch(`/api/v1/projects/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useAddScreen(key: string) {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (body: ScreenPatch & { page: string; description: string; attachmentID: string }) =>
      apiFetch<{ screen: ProjectScreen }>(`/api/v1/projects/${encodeURIComponent(key)}/screens`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateScreen(key: string) {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ScreenPatch }) =>
      apiFetch<{ screen: ProjectScreen }>(
        `/api/v1/projects/${encodeURIComponent(key)}/screens/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteScreen(key: string) {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/v1/projects/${encodeURIComponent(key)}/screens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}
