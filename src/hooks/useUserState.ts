import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { UserState } from '@/types';

// "Ignore our own user-state echo" window, mirroring the drafts pattern:
// every user-state write this tab performs (thread-seen PUTs, and the
// server-side author-seen a thread-reply send triggers) comes straight
// back as a `userchannel.updated {userState:true}` event. Without the
// window, every thread reply cost a full /user-state refetch of data this
// tab already has. Other tabs never arm it, so cross-tab sync still works.
const LOCAL_USER_STATE_EVENT_IGNORE_MS = 1500;
let ignoreUserStateEventsUntil = 0;

export function markLocalUserStateWrite() {
  ignoreUserStateEventsUntil = Date.now() + LOCAL_USER_STATE_EVENT_IGNORE_MS;
}

export function shouldRefetchUserStateForRemoteUpdate(): boolean {
  return Date.now() >= ignoreUserStateEventsUntil;
}

// Cleared on logout (with the drafts session state) so a different user in
// the same document never inherits a suppression window.
export function resetUserStateSessionState() {
  ignoreUserStateEventsUntil = 0;
}

const EMPTY_USER_STATE: UserState = {
  threadNotifications: [],
  threadSeen: {},
  hiddenConversations: [],
  hiddenSkills: [],
};

export function useUserState(options?: { enabled?: boolean }) {
  return useQuery<UserState>({
    queryKey: queryKeys.userState(),
    queryFn: async () => {
      const state = await apiFetch<UserState>('/api/v1/user-state');
      return {
        threadNotifications: state.threadNotifications ?? [],
        threadSeen: state.threadSeen ?? {},
        hiddenConversations: state.hiddenConversations ?? [],
        hiddenSkills: state.hiddenSkills ?? [],
      };
    },
    enabled: options?.enabled ?? true,
    staleTime: 15_000,
    placeholderData: EMPTY_USER_STATE,
  });
}

// useSetSkillHidden toggles one skill in/out of THIS user's agent discovery
// index ("# Workspace skills"). Hiding is curation, not permission — an
// explicit /skill pick still attaches a hidden skill.
export function useSetSkillHidden() {
  const qc = useQueryClient();
  return useMutation({
    onMutate: markLocalUserStateWrite,
    mutationFn: ({ id, hidden }: { id: string; hidden: boolean }) =>
      apiFetch<void>(`/api/v1/user-state/skills/${encodeURIComponent(id)}/hidden`, {
        method: hidden ? 'PUT' : 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.userState() });
    },
  });
}

export function useMarkThreadSeen() {
  const qc = useQueryClient();
  return useMutation({
    // Arm the echo window BEFORE the PUT — the server publishes the
    // userState event mid-request (this mutation already self-invalidates
    // in onSuccess, so the echo-driven second refetch was pure waste).
    onMutate: markLocalUserStateWrite,
    mutationFn: (target: { parentID: string; parentType: string; threadRootID: string }) => {
      const parentType = target.parentType === 'channel' ? 'channels' : 'conversations';
      return apiFetch<void>(
        `/api/v1/user-state/threads/${parentType}/${encodeURIComponent(target.parentID)}/${encodeURIComponent(target.threadRootID)}/seen`,
        { method: 'PUT' },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.userState() });
      qc.invalidateQueries({ queryKey: queryKeys.userThreads() });
    },
  });
}
