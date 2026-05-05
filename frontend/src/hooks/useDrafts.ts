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
const draftMutationVersions = new Map<string, number>();
const LOCAL_DRAFT_EVENT_IGNORE_MS = 1500;
let ignoreDraftEventsUntil = 0;

function draftScopeKey(scope: DraftScope): string {
  return `${scope.parentType}:${scope.parentID ?? ''}:${scope.parentMessageID ?? ''}`;
}

function isSuppressedSentDraft(draft: MessageDraft): boolean {
  return suppressedSentDraftScopes.has(draftScopeKey(draft));
}

function nextDraftMutationVersion(scope: DraftScope): { key: string; version: number } {
  ignoreDraftEventsUntil = Date.now() + LOCAL_DRAFT_EVENT_IGNORE_MS;
  const key = draftScopeKey(scope);
  const version = (draftMutationVersions.get(key) ?? 0) + 1;
  draftMutationVersions.set(key, version);
  return { key, version };
}

function markLocalDraftDelete() {
  ignoreDraftEventsUntil = Date.now() + LOCAL_DRAFT_EVENT_IGNORE_MS;
}

export function shouldRefetchDraftsForRemoteUpdate(): boolean {
  return Date.now() >= ignoreDraftEventsUntil;
}

function isLatestDraftMutation(key: string, version: number): boolean {
  return draftMutationVersions.get(key) === version;
}

function sameDraftScope(draft: MessageDraft, scope: DraftScope): boolean {
  return (
    draft.parentID === scope.parentID &&
    draft.parentType === scope.parentType &&
    (draft.parentMessageID ?? '') === (scope.parentMessageID ?? '')
  );
}

function patchDraftListByScope(
  drafts: MessageDraft[] | undefined,
  scope: DraftScope,
  draft: MessageDraft | null,
): MessageDraft[] | undefined {
  if (!drafts) return drafts;
  const withoutScope = drafts.filter((item) => !sameDraftScope(item, scope));
  if (!draft || isSuppressedSentDraft(draft)) return withoutScope;
  return [draft, ...withoutScope];
}

function sortedAttachmentIDs(ids: string[] | undefined): string[] {
  return [...(ids ?? [])].sort();
}

function sameAttachmentIDs(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = sortedAttachmentIDs(a);
  const right = sortedAttachmentIDs(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function findDraftByScope(drafts: MessageDraft[] | undefined, scope: DraftScope): MessageDraft | undefined {
  return drafts?.find((draft) => sameDraftScope(draft, scope));
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
    mutationFn: (input: SaveDraftInput) => {
      const existing = findDraftByScope(qc.getQueryData<MessageDraft[]>(queryKeys.drafts()), input);
      const attachmentIDs = input.attachmentIDs ?? [];
      if (input.body === '' && attachmentIDs.length === 0 && !existing) {
        return Promise.resolve(undefined);
      }
      if (
        existing &&
        existing.body === input.body &&
        sameAttachmentIDs(existing.attachmentIDs, attachmentIDs)
      ) {
        return Promise.resolve(existing);
      }
      return apiFetch<MessageDraft | void>('/api/v1/drafts', {
        method: 'PUT',
        body: JSON.stringify({
          parentID: input.parentID,
          parentType: input.parentType,
          parentMessageID: input.parentMessageID ?? '',
          body: input.body,
          attachmentIDs,
        }),
      });
    },
    onMutate: (input) => nextDraftMutationVersion(input),
    onSuccess: (draft, input, ctx) => {
      if (!ctx || !isLatestDraftMutation(ctx.key, ctx.version)) return;
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => patchDraftListByScope(old, input, draft ?? null),
      );
    },
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    onMutate: markLocalDraftDelete,
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/drafts/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, id) => {
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => old?.filter((draft) => draft.id !== id),
      );
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
