import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

// One shared workspace agent as served by GET /api/v1/agents. The agent
// itself belongs to no one; `prefs` are the CALLER's own settings for it
// (empty field = inherit the workspace default), `resolved` is what a run
// the caller starts would use, and `status` is the caller's availability
// (runs execute on the caller's machine).
export interface AgentLimits {
  maxTurns?: number;
  // Conversation cap: watch/heartbeat/follow-up runs (short replies).
  maxWallClockSec?: number;
  maxTokens?: number;
  maxPosts?: number;
  maxConsultDepth?: number;
  maxChainRounds?: number;
  // Task caps: direct @mentions (coding/research may run long & deep). The
  // wall clock is a hard ceiling — runs live on a short rolling deadline that
  // activity extends.
  maxTaskWallClockSec?: number;
  maxTaskTurns?: number;
}

export interface UserAgentPrefs {
  userID: string;
  slug: string;
  harness?: string;
  model?: string;
  persona?: string;
  limits?: AgentLimits | null;
  offlinePolicy?: string;
  executionMode?: string; // API harnesses: "" | "runner" | "server"
  followUpMode?: string; // "" | "off" | "window" | "always"
  followUpMins?: number;
  followUpAsk?: boolean;
}

export interface ResolvedAgentConfig {
  harness: string;
  model: string;
  persona: string;
  limits: AgentLimits;
  maxConcurrentRuns: number;
}

export interface AgentView {
  id: string;
  displayName: string;
  slug: string;
  status: 'active' | 'needs_setup' | 'offline' | string;
  prefs: UserAgentPrefs;
  resolved: ResolvedAgentConfig;
}

// Patch shape for PATCH /api/v1/agents/{slug}/prefs. Empty string resets a
// field to inherit the workspace default.
export interface AgentPrefsPatch {
  harness?: string;
  model?: string;
  persona?: string;
  offlinePolicy?: string;
  executionMode?: string;
  limits?: AgentLimits | null;
  followUpMode?: string;
  followUpMins?: number;
  followUpAsk?: boolean;
}

export interface AgentSubscription {
  id: string;
  agentID: string;
  creatorID: string;
  parentID: string;
  parentType: string;
  keywords?: string[];
  heartbeatMins?: number;
  threadRootID?: string;
  instruction?: string;
  actionMode?: WatchActionMode;
  // Catch-up state: the watcher missed triggers (pendingSince). When the miss
  // happened while the creator was OFFLINE and the agent is a local CLI, the
  // backend asks before processing — the card offers Process / Dismiss.
  pendingCatchUp?: boolean;
  pendingOffline?: boolean;
  pendingSince?: string;
}

// Watcher action modes — the autonomy dial, ascending. notify/draft never
// post publicly (server-enforced).
export const WATCH_ACTION_MODES = [
  { value: 'notify', label: 'Notify me (DM only)', hint: 'DMs you a heads-up. Never posts publicly.' },
  { value: 'draft', label: 'Draft a reply for me', hint: 'DMs you a ready-to-send reply. Never posts.' },
  { value: 'reply', label: 'Reply as me (ask first)', hint: 'Posts on your behalf, but asks you to approve each time.' },
  { value: 'autonomous', label: 'Reply as me (autonomous)', hint: 'Posts on your behalf without asking. Highest risk.' },
] as const;
export type WatchActionMode = (typeof WATCH_ACTION_MODES)[number]['value'];

const AGENTS_KEY = ['agents'] as const;
const subsKey = (slug: string) => ['agent-subs', slug] as const;

// useCreateWatcher attaches a watcher to a channel/DM or (with threadRootID) a
// single thread: a standing order + action mode for the chosen agent.
export function useCreateWatcher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      slug: string;
      parentID: string;
      parentType: string;
      threadRootID?: string;
      instruction?: string;
      actionMode?: WatchActionMode;
      keywords?: string[];
    }) => {
      const { slug, ...rest } = body;
      return apiFetch(`/api/v1/agents/${slug}/subscriptions`, {
        method: 'POST',
        body: JSON.stringify(rest),
      });
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: subsKey(vars.slug) });
      void queryClient.invalidateQueries({ queryKey: ['parent-watchers'] });
    },
  });
}

// Watched channels: the caller's subscriptions for one agent.
export function useAgentSubscriptions(slug: string) {
  return useQuery({
    queryKey: subsKey(slug),
    queryFn: async () => {
      const res = await apiFetch<{ subscriptions: AgentSubscription[] }>(
        `/api/v1/agents/${slug}/subscriptions`,
      );
      return res.subscriptions ?? [];
    },
  });
}

export function useCreateAgentSubscription(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      parentID: string;
      parentType?: string;
      keywords?: string[];
      heartbeatMins?: number;
    }) =>
      apiFetch(`/api/v1/agents/${slug}/subscriptions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: subsKey(slug) }),
  });
}

const watchersKey = (parentType: string, parentID: string) =>
  ['parent-watchers', parentType, parentID] as const;

// useParentWatchers returns the viewer's OWN watchers in a channel/DM, across
// all agents — so the message list can badge watched threads. Cheap enough to
// keep fresh; watcher create/delete invalidate it.
export function useParentWatchers(parentType: 'channel' | 'conversation', parentID: string | undefined) {
  return useQuery({
    queryKey: watchersKey(parentType, parentID ?? ''),
    enabled: !!parentID,
    // Periodic refetch so a catch-up ask (set server-side while this view is
    // open) surfaces without a reload.
    refetchInterval: 30_000,
    queryFn: async () => {
      const base = parentType === 'conversation' ? 'conversations' : 'channels';
      const res = await apiFetch<{ watchers: AgentSubscription[] }>(
        `/api/v1/${base}/${parentID}/watchers`,
      );
      return res?.watchers ?? [];
    },
  });
}

// useDecideCatchUp answers a watcher's catch-up ask: process the backlog now
// (one coalesced run) or dismiss it.
export function useDecideCatchUp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { parentID: string; id: string; process: boolean }) =>
      apiFetch(`/api/v1/watchers/${vars.parentID}/${vars.id}/catchup`, {
        method: 'POST',
        body: JSON.stringify({ process: vars.process }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['parent-watchers'] }),
  });
}

// invalidateParentWatchers refreshes the badge set after a watcher is added or
// removed (create/delete only know the agent slug, not the parent key).
export function useInvalidateParentWatchers() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['parent-watchers'] });
}

// useUpdateWatcher edits a watcher's standing order (instruction + action mode)
// in place. Agent + thread are fixed; changing those is remove + re-add.
export function useUpdateWatcher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      slug: string;
      parentID: string;
      id: string;
      instruction: string;
      actionMode: WatchActionMode;
    }) => {
      const { slug, parentID, id, ...patch } = vars;
      return apiFetch(`/api/v1/agents/${slug}/subscriptions/${parentID}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: subsKey(vars.slug) });
      void queryClient.invalidateQueries({ queryKey: ['parent-watchers'] });
    },
  });
}

// useRemoveWatcher deletes a watcher given its agent slug + parent + id (the
// badge menu knows all three), refreshing both the per-agent list and badges.
export function useRemoveWatcher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { slug: string; parentID: string; id: string }) =>
      apiFetch(`/api/v1/agents/${vars.slug}/subscriptions/${vars.parentID}/${vars.id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: subsKey(vars.slug) });
      void queryClient.invalidateQueries({ queryKey: ['parent-watchers'] });
    },
  });
}

export function useDeleteAgentSubscription(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ parentID, id }: { parentID: string; id: string }) =>
      apiFetch(`/api/v1/agents/${slug}/subscriptions/${parentID}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: subsKey(slug) });
      void queryClient.invalidateQueries({ queryKey: ['parent-watchers'] });
    },
  });
}

export function useAgents() {
  return useQuery({
    queryKey: AGENTS_KEY,
    queryFn: async () => {
      const res = await apiFetch<{ agents: AgentView[] }>('/api/v1/agents');
      // ?? [] — react-query treats undefined data as an error (and generic
      // apiFetch mocks in tests resolve undefined).
      return res?.agents ?? [];
    },
  });
}

// ---------------------------------------------------------------- skills

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const SKILLS_KEY = ['skills'] as const;

export function useSkills() {
  return useQuery({
    queryKey: SKILLS_KEY,
    queryFn: async () => {
      const res = await apiFetch<{ skills: Skill[] }>('/api/v1/skills');
      return res.skills ?? [];
    },
  });
}

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; description: string; instructions: string }) =>
      apiFetch<{ skill: Skill }>('/api/v1/skills', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SKILLS_KEY }),
  });
}

export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { name?: string; description?: string; instructions?: string };
    }) =>
      apiFetch<{ skill: Skill }>(`/api/v1/skills/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SKILLS_KEY }),
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => apiFetch(`/api/v1/skills/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SKILLS_KEY }),
  });
}

// useCreateAgent defines a new shared agent (admin-only, enforced server-side).
export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      slug: string;
      displayName: string;
      harness: string;
      model: string;
      executionMode: string;
      persona: string;
    }) => apiFetch('/api/v1/agents', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: AGENTS_KEY }),
  });
}

export function useUpdateAgentPrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ slug, patch }: { slug: string; patch: AgentPrefsPatch }) =>
      apiFetch<AgentView>(`/api/v1/agents/${slug}/prefs`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AgentView[]>(AGENTS_KEY, (prev) =>
        prev?.map((a) => (a.slug === updated.slug ? updated : a)),
      );
    },
  });
}
