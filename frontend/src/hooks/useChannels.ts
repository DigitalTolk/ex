import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { UserChannel, Channel, ChannelMembership } from '@/types';

export function useUserChannels() {
  return useQuery({
    queryKey: ['userChannels'],
    queryFn: () => apiFetch<UserChannel[]>('/api/v1/channels'),
  });
}

export function useChannel(channelId: string | undefined) {
  return useQuery({
    queryKey: ['channel', channelId],
    queryFn: () => apiFetch<Channel>(`/api/v1/channels/${channelId}`),
    enabled: !!channelId,
  });
}

export function useChannelBySlug(slug: string | undefined) {
  return useQuery({
    queryKey: ['channelBySlug', slug],
    queryFn: () => apiFetch<Channel>(`/api/v1/channels/${slug}`),
    enabled: !!slug,
  });
}

export function useChannelMembers(channelId: string | undefined) {
  return useQuery({
    queryKey: ['channelMembers', channelId],
    queryFn: () =>
      apiFetch<ChannelMembership[]>(
        `/api/v1/channels/${channelId}/members`,
      ),
    enabled: !!channelId,
  });
}

export function useBrowseChannels() {
  return useQuery({
    queryKey: ['browseChannels'],
    queryFn: () => apiFetch<Channel[]>('/api/v1/channels/browse'),
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
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
      queryClient.invalidateQueries({ queryKey: ['browseChannels'] });
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
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
      queryClient.invalidateQueries({ queryKey: ['browseChannels'] });
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
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
    },
  });
}
