import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { SidebarCategory } from '@/types';

// SidebarItemKind selects whether a sidebar attribute mutation targets a
// channel or a conversation. The two paths differ only in URL prefix
// and which React Query cache they invalidate; everything else is shared.
type SidebarItemKind = 'channel' | 'conversation';

const URL_PREFIX: Record<SidebarItemKind, string> = {
  channel: '/api/v1/channels',
  conversation: '/api/v1/conversations',
};

const INVALIDATE_KEY: Record<SidebarItemKind, readonly string[]> = {
  channel: ['userChannels'],
  conversation: ['userConversations'],
};

// useCategories returns the user's sidebar categories.
export function useCategories() {
  return useQuery<SidebarCategory[]>({
    queryKey: ['sidebarCategories'],
    queryFn: () => apiFetch<SidebarCategory[]>('/api/v1/sidebar/categories'),
    staleTime: 30_000,
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<SidebarCategory>('/api/v1/sidebar/categories', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sidebarCategories'] }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name?: string; position?: number }) =>
      apiFetch<SidebarCategory>(`/api/v1/sidebar/categories/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: vars.name, position: vars.position }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sidebarCategories'] }),
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/v1/sidebar/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sidebarCategories'] });
      // Channels and DMs assigned to a deleted category fall back to
      // their default sections; the user-side rows still carry the
      // (now-stale) categoryID, so refetch both lists.
      qc.invalidateQueries({ queryKey: ['userChannels'] });
      qc.invalidateQueries({ queryKey: ['userConversations'] });
    },
  });
}

// usePutSidebarAttr returns a mutation that PUTs a single attribute on a
// channel or conversation's user-side row (favorite or category) and
// invalidates the right list cache. Internal — exported callers below
// pin the kind/attr at compile time.
function usePutSidebarAttr(kind: SidebarItemKind, attr: 'favorite' | 'category') {
  const qc = useQueryClient();
  const invalidateKey = INVALIDATE_KEY[kind];
  return useMutation({
    mutationFn: (vars: { id: string; body: Record<string, unknown> }) =>
      apiFetch(`${URL_PREFIX[kind]}/${vars.id}/${attr}`, {
        method: 'PUT',
        body: JSON.stringify(vars.body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidateKey }),
  });
}

export function useFavoriteChannel() {
  const m = usePutSidebarAttr('channel', 'favorite');
  return {
    ...m,
    mutate: (vars: { channelID: string; favorite: boolean }) =>
      m.mutate({ id: vars.channelID, body: { favorite: vars.favorite } }),
  };
}

export function useSetCategory() {
  const m = usePutSidebarAttr('channel', 'category');
  return {
    ...m,
    mutate: (vars: { channelID: string; categoryID: string }) =>
      m.mutate({ id: vars.channelID, body: { categoryID: vars.categoryID } }),
  };
}

export function useFavoriteConversation() {
  const m = usePutSidebarAttr('conversation', 'favorite');
  return {
    ...m,
    mutate: (vars: { conversationID: string; favorite: boolean }) =>
      m.mutate({ id: vars.conversationID, body: { favorite: vars.favorite } }),
  };
}

export function useSetConversationCategory() {
  const m = usePutSidebarAttr('conversation', 'category');
  return {
    ...m,
    mutate: (vars: { conversationID: string; categoryID: string }) =>
      m.mutate({ id: vars.conversationID, body: { categoryID: vars.categoryID } }),
  };
}
