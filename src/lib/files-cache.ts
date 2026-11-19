import type { QueryClient } from '@tanstack/react-query';
import { parentPath, queryKeys } from '@/lib/query-keys';

// invalidateParentFiles refetches a channel's or conversation's Files panel
// (every name filter of it) when its files changed: an upload, a deleted
// message, a shared SharePoint link. A closed panel only goes stale.
export function invalidateParentFiles(qc: QueryClient, parentID: string, parentType: string | undefined): void {
  if (parentType !== 'channel' && parentType !== 'conversation') return;
  const path = parentPath(parentType === 'channel' ? { channelId: parentID } : { conversationId: parentID });
  void qc.invalidateQueries({ queryKey: queryKeys.filesIn(path) });
}
