import { useQuery, useMutation, useQueryClient, type MutateOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { wsLiveQueryOptions } from '@/lib/query-client';
import { showToast } from '@/lib/toast';
import type { UserChannel, Channel, ChannelMembership, ChannelNotificationOverride } from '@/types';

// select narrows what the caller subscribes to: with structural sharing, a
// selected shape that didn't change (e.g. names and slugs on an unread bump)
// doesn't re-render the caller.
export function useUserChannels<T = UserChannel[]>(options?: { enabled?: boolean; select?: (rows: UserChannel[]) => T }) {
  return useQuery({
    queryKey: queryKeys.userChannels(),
    queryFn: async () => {
      const res = await apiFetch<UserChannel[]>('/api/v1/channels');
      return Array.isArray(res) ? res : [];
    },
    ...wsLiveQueryOptions,
    enabled: options?.enabled ?? true,
    select: options?.select,
  });
}

export function useChannel(channelId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.channel(channelId ?? ''),
    // Coerce a 204/empty body to null — a queryFn must never resolve undefined
    // (React Query warns); null is the "loaded, absent" sentinel.
    queryFn: async () => (await apiFetch<Channel>(`/api/v1/channels/${channelId}`)) ?? null,
    enabled: !!channelId,
  });
}

export function useChannelBySlug(slug: string | undefined) {
  return useQuery({
    queryKey: queryKeys.channelBySlug(slug),
    queryFn: async () => (await apiFetch<Channel>(`/api/v1/channels/${slug}`)) ?? null,
    enabled: !!slug,
  });
}

export function useChannelMembers(channelId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.channelMembers(channelId),
    queryFn: async () => {
      const res = await apiFetch<ChannelMembership[]>(
        `/api/v1/channels/${channelId}/members`,
      );
      return Array.isArray(res) ? res : [];
    },
    // members.changed invalidates it (ChatPage).
    ...wsLiveQueryOptions,
    enabled: !!channelId,
  });
}

// useBrowseChannels lists public channels for the directory. When `q`
// is non-empty the backend routes the call through OpenSearch (when
// configured) and returns matched channels; otherwise it returns the
// full paginated browse so the UI can filter client-side as before.
export function useBrowseChannels(q?: string) {
  const trimmed = (q ?? '').trim();
  return useQuery({
    queryKey: queryKeys.browseChannels(trimmed),
    queryFn: async () => {
      const url = trimmed
        ? `/api/v1/channels/browse?q=${encodeURIComponent(trimmed)}`
        : '/api/v1/channels/browse';
      const res = await apiFetch<Channel[]>(url);
      return Array.isArray(res) ? res : [];
    },
  });
}

export function useCreateChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description?: string; type: 'public' | 'private' }) =>
      apiFetch<Channel>('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
    },
  });
}

export function useJoinChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<void>(`/api/v1/channels/${channelId}/join`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
    },
  });
}

export function useMuteChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; muted: boolean }) =>
      apiFetch<void>(`/api/v1/channels/${vars.channelId}/mute`, {
        method: 'PUT',
        body: JSON.stringify({ muted: vars.muted }),
      }),
    // Refresh the user's channel list so the sidebar bell-slash indicator
    // updates. The server also broadcasts channel.muted via WebSocket so
    // other tabs/devices stay in sync.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
  });
}

// useSetChannelNotificationPrefs persists per-channel notification overrides.
// A nil/omitted field means "inherit the account default". The server echoes
// userchannel.updated over WebSocket so other tabs/devices stay in sync; we
// also refresh userChannels locally so the modal reflects the saved state.
export function useSetChannelNotificationPrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; override: ChannelNotificationOverride }) =>
      apiFetch<void>(`/api/v1/channels/${vars.channelId}/notification-preferences`, {
        method: 'PUT',
        body: JSON.stringify(vars.override),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
  });
}

// A channel action from the header menu or the archived notice: archive,
// unarchive, leave, or a description edit. A failure says so in a toast (the
// callers are fire-and-forget menu handlers, so a thrown request used to end
// as an unhandled rejection with nothing on screen), and run() drops a second
// trigger while the first request is still out — a re-confirmed archive or a
// double-tapped Leave sends one request. isMutating reads the mutation cache
// synchronously, so even two clicks inside one frame see the first.
function useChannelAction<TVars>(
  action: string,
  mutationFn: (vars: TVars) => Promise<unknown>,
  onSuccess: () => void,
  errorMessage: string,
) {
  const queryClient = useQueryClient();
  const mutationKey = ['channel-action', action] as const;
  const mutation = useMutation({
    mutationKey,
    mutationFn,
    onSuccess,
    onError: () => showToast(errorMessage),
  });
  return {
    isPending: mutation.isPending,
    run(vars: TVars, options?: MutateOptions<unknown, Error, TVars>) {
      if (queryClient.isMutating({ mutationKey }) > 0) return;
      mutation.mutate(vars, options);
    },
  };
}

// Archiving keeps the channel readable in place: refetch the row and the
// open channel so the composer turns into the archived notice.
export function useArchiveChannel() {
  const queryClient = useQueryClient();
  return useChannelAction(
    'archive',
    (channelId: string) => apiFetch<void>(`/api/v1/channels/${channelId}`, { method: 'DELETE' }),
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelBySlug() });
    },
    "Couldn't archive the channel. Try again.",
  );
}

export function useUnarchiveChannel() {
  const queryClient = useQueryClient();
  return useChannelAction(
    'unarchive',
    (channelId: string) => apiFetch<void>(`/api/v1/channels/${channelId}/unarchive`, { method: 'POST' }),
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelBySlug() });
    },
    "Couldn't unarchive the channel. Try again.",
  );
}

export function useLeaveChannel() {
  const queryClient = useQueryClient();
  return useChannelAction(
    'leave',
    (channelId: string) => apiFetch<void>(`/api/v1/channels/${channelId}/leave`, { method: 'POST' }),
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
    "Couldn't leave the channel. Try again.",
  );
}

export function useUpdateChannelDescription() {
  const queryClient = useQueryClient();
  return useChannelAction(
    'description',
    (vars: { channelId: string; description: string }) =>
      apiFetch<void>(`/api/v1/channels/${vars.channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: vars.description }),
      }),
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelBySlug() });
    },
    "Couldn't save the description. Try again.",
  );
}

// Renames a channel. Its slug — the URL key — follows the name; the server
// answers 409 when another channel holds it.
export function useRenameChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; name: string }) =>
      apiFetch<Channel>(`/api/v1/channels/${vars.channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: vars.name }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelBySlug() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
  });
}

// Adds people to a channel as members (the member list's picker adds one, the
// post-send invite prompt everyone it mentioned). Callers show their own
// inline error, so failures are not toasted here.
export function useAddChannelMembers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; userIds: string[] }) =>
      Promise.all(
        vars.userIds.map((userID) =>
          apiFetch<void>(`/api/v1/channels/${encodeURIComponent(vars.channelId)}/members`, {
            method: 'POST',
            body: JSON.stringify({ userID, role: 'member' }),
          }),
        ),
      ),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(vars.channelId) });
    },
  });
}

export function useRemoveChannelMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; userId: string }) =>
      apiFetch<void>(`/api/v1/channels/${vars.channelId}/members/${vars.userId}`, { method: 'DELETE' }),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(vars.channelId) });
    },
  });
}
