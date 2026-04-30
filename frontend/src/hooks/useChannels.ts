import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { UserChannel, Channel, ChannelMembership } from '@/types';

export function useUserChannels() {
  return useQuery({
    queryKey: queryKeys.userChannels(),
    queryFn: () => apiFetch<UserChannel[]>('/api/v1/channels'),
  });
}

export function useChannel(channelId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.channel(channelId ?? ''),
    queryFn: () => apiFetch<Channel>(`/api/v1/channels/${channelId}`),
    enabled: !!channelId,
  });
}

export function useChannelBySlug(slug: string | undefined) {
  return useQuery({
    queryKey: queryKeys.channelBySlug(slug),
    queryFn: () => apiFetch<Channel>(`/api/v1/channels/${slug}`),
    enabled: !!slug,
  });
}

export function useChannelMembers(channelId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.channelMembers(channelId),
    queryFn: () =>
      apiFetch<ChannelMembership[]>(
        `/api/v1/channels/${channelId}/members`,
      ),
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
    queryFn: () => {
      const url = trimmed
        ? `/api/v1/channels/browse?q=${encodeURIComponent(trimmed)}`
        : '/api/v1/channels/browse';
      return apiFetch<Channel[]>(url);
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
