import { createContext, useContext } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { parentPath, queryKeys } from '@/lib/query-keys';
import { useWorkspaceSettings } from '@/hooks/useSettings';
import { invalidateParentFiles } from '@/lib/files-cache';
import type { SharePointLink } from '@/types/generated';
import type { WSEventPayloads } from '@/lib/ws-events';

export interface SharePointParent {
  channelId?: string;
  conversationId?: string;
}

const NO_HOSTS: readonly string[] = [];

// The hosts whose links are shared SharePoint files, for every message row:
// set once at the app root (SharePointHostsProvider) so no row reads the
// settings itself. Empty while sharing is off, or outside the provider.
export const SharePointHostsContext = createContext<readonly string[]>(NO_HOSTS);

export function useSharePointHosts(): readonly string[] {
  return useContext(SharePointHostsContext);
}

// The hosts as the workspace settings name them, once signed in.
export function useSharePointHostsSetting(signedIn: boolean): readonly string[] {
  const { data } = useWorkspaceSettings(signedIn);
  return data?.sharePointHosts ?? NO_HOSTS;
}

function parentQuery(parent: SharePointParent, extra: Record<string, string>): string {
  const params = new URLSearchParams({
    parentType: parent.channelId ? 'channel' : 'conversation',
    parentID: (parent.channelId ?? parent.conversationId) as string,
    ...extra,
  });
  return params.toString();
}

// useSharePointLink reads a posted link's card: the file, and for the person
// who posted it, how sharing went. null when the link was never shared (it
// predates sharing, or was posted in ~general). Refreshed by the
// sharepoint.changed event, never by polling.
export function useSharePointLink(parent: SharePointParent, url: string, enabled = true) {
  return useQuery<SharePointLink | null>({
    queryKey: queryKeys.sharePointLink(parentPath(parent), url),
    queryFn: async () => (await apiFetch<SharePointLink | undefined>(`/api/v1/sharepoint/link?${parentQuery(parent, { url })}`)) ?? null,
    enabled: enabled && !!(parent.channelId || parent.conversationId),
    staleTime: Infinity,
    retry: false,
  });
}

// useSharePointPreview reads the short-lived address that shows a shared file
// as it is (Office for the web's viewer), fetched as the viewer. Read once
// each time the lightbox shows the file: the address expires and acts as the
// viewer, so it is never kept, nor read again while it shows.
export function useSharePointPreview(parent: SharePointParent, fileID: string) {
  return useQuery({
    queryKey: queryKeys.sharePointPreview(parentPath(parent), fileID),
    queryFn: async () =>
      (await apiFetch<{ url: string }>(`/api/v1/sharepoint/preview?${parentQuery(parent, { fileID })}`)).url,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

// Shares a link that failed again, as the person who posted it.
export function useRetrySharePointLink(parent: SharePointParent, url: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>('/api/v1/sharepoint/link/retry', {
        method: 'POST',
        body: JSON.stringify({
          parentType: parent.channelId ? 'channel' : 'conversation',
          parentID: parent.channelId ?? parent.conversationId,
          url,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sharePointLink(parentPath(parent), url) }),
  });
}

// sharepoint.changed: refetch the cards of the links that changed (all of the
// parent's when the list is empty) and its Files panel.
export function applySharePointChangedEvent(qc: QueryClient, e: WSEventPayloads['sharepoint.changed']) {
  const path = parentPath(e.parentType === 'channel' ? { channelId: e.parentID } : { conversationId: e.parentID });
  if (e.urls.length === 0) {
    void qc.invalidateQueries({ queryKey: queryKeys.sharePointLinks(path) });
  }
  for (const url of e.urls) {
    void qc.invalidateQueries({ queryKey: queryKeys.sharePointLink(path, url) });
  }
  invalidateParentFiles(qc, e.parentID, e.parentType);
}
