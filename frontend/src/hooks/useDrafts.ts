import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { MessageDraft } from '@/types';
import { useAttachmentsBatch } from './useAttachments';

export interface DraftScope {
  parentID?: string;
  parentType: 'channel' | 'conversation';
  parentMessageID?: string;
}

export interface SaveDraftInput {
  parentID: string;
  parentType: 'channel' | 'conversation';
  parentMessageID?: string;
  body: string;
  attachmentIDs?: string[];
}

const suppressedSentDraftScopes = new Set<string>();

function draftScopeKey(scope: DraftScope): string {
  return `${scope.parentType}:${scope.parentID ?? ''}:${scope.parentMessageID ?? ''}`;
}

function isSuppressedSentDraft(draft: MessageDraft): boolean {
  return suppressedSentDraftScopes.has(draftScopeKey(draft));
}

export function suppressSentDraft(scope: DraftScope) {
  suppressedSentDraftScopes.add(draftScopeKey(scope));
}

export function restoreDraftScope(scope: DraftScope) {
  suppressedSentDraftScopes.delete(draftScopeKey(scope));
}

export function restoreDraftScopeForContent(scope: DraftScope, value: { body: string; attachmentIDs?: string[] }) {
  if (value.body !== '' || (value.attachmentIDs?.length ?? 0) > 0) {
    restoreDraftScope(scope);
  }
}

export function useDrafts() {
  return useQuery({
    queryKey: queryKeys.drafts(),
    queryFn: async () => {
      const res = await apiFetch<MessageDraft[]>('/api/v1/drafts');
      return Array.isArray(res) ? res.filter((draft) => !isSuppressedSentDraft(draft)) : [];
    },
    staleTime: 15_000,
  });
}

export function useDraftForScope(scope: DraftScope) {
  const drafts = useDrafts();
  return {
    ...drafts,
    data: drafts.data?.find(
      (d) =>
        d.parentID === scope.parentID &&
        d.parentType === scope.parentType &&
        (d.parentMessageID ?? '') === (scope.parentMessageID ?? ''),
    ),
  };
}

export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveDraftInput) =>
      apiFetch<MessageDraft | void>('/api/v1/drafts', {
        method: 'PUT',
        body: JSON.stringify({
          parentID: input.parentID,
          parentType: input.parentType,
          parentMessageID: input.parentMessageID ?? '',
          body: input.body,
          attachmentIDs: input.attachmentIDs ?? [],
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.drafts() });
    },
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/drafts/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.drafts() });
    },
  });
}

export function useDraftAttachmentChips(attachmentIDs: string[] | undefined): DraftAttachment[] {
  const ids = useMemo(() => attachmentIDs ?? [], [attachmentIDs]);
  const { map } = useAttachmentsBatch(ids);
  return useMemo(
    () =>
      ids
        .map((id): DraftAttachment | null => {
          const att = map.get(id);
          if (!att) return null;
          return {
            id: att.id,
            filename: att.filename,
            contentType: att.contentType,
            size: att.size,
            progress: 1,
          };
        })
        .filter((att): att is DraftAttachment => att !== null),
    [ids, map],
  );
}
