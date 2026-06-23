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
  // Keystroke save: persist the draft but don't surface the sidebar "draft
  // available" indicator (no broadcast, no local cache patch). The composer
  // sends a non-silent save when it loses focus so the indicator appears
  // only then.
  silent?: boolean;
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

// isScopeSuppressed reports whether a scope was just sent (so any draft for it
// should be cleared, not surfaced). Restored when the user types new content.
function isScopeSuppressed(scope: DraftScope): boolean {
  return suppressedSentDraftScopes.has(draftScopeKey(scope));
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

export function useDrafts(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.drafts(),
    queryFn: async () => {
      const res = await apiFetch<MessageDraft[]>('/api/v1/drafts');
      return Array.isArray(res) ? res.filter((draft) => !isSuppressedSentDraft(draft)) : [];
    },
    enabled: options?.enabled ?? true,
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
          notify: !input.silent,
        }),
      });
    },
    onMutate: (input) => nextDraftMutationVersion(input),
    onSuccess: (draft, input, ctx) => {
      /* istanbul ignore next -- ctx is always set: onMutate unconditionally returns the version object */
      if (!ctx) return;
      if (!isLatestDraftMutation(ctx.key, ctx.version)) return;
      // Self-heal a send/save race: on a slow connection a keystroke save can be
      // in flight when the user sends. By the time it lands, the scope is
      // suppressed (sent) — so the draft we just (re)created on the server would
      // linger. Delete it. (Skipped once the user types NEW content, which
      // un-suppresses the scope.) Fall through so the cache-patch below also
      // drops it from the list.
      if (draft?.id && isScopeSuppressed(input)) {
        markLocalDraftDelete();
        void apiFetch<void>(`/api/v1/drafts/${draft.id}`, { method: 'DELETE' }).catch(() => undefined);
      }
      // Silent (keystroke) saves persist server-side but must not surface the
      // draft in the sidebar yet — leave the local list untouched so the
      // indicator stays hidden until the non-silent focus-loss save patches it.
      if (input.silent) return;
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => patchDraftListByScope(old, input, draft ?? null),
      );
    },
  });
}

// useClearDraftForScope deletes the server-side draft for a composer scope on
// send. It empty-PUTs (the server deletes the scope's draft, whose id is derived
// from the scope) so it works even when the draft was only ever saved SILENTLY
// this session and its id was never cached — the case that left a draft behind
// after sending on a slow connection. Gated on the scope still being suppressed
// so it can't clobber a fresh draft the user started right after sending.
export function useClearDraftForScope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope: DraftScope) => {
      if (!scope.parentID || !isScopeSuppressed(scope)) {
        // Not suppressed → the user started a new draft after sending; leave it.
        return Promise.resolve();
      }
      markLocalDraftDelete();
      return apiFetch<void>('/api/v1/drafts', {
        method: 'PUT',
        body: JSON.stringify({
          parentID: scope.parentID,
          parentType: scope.parentType,
          parentMessageID: scope.parentMessageID ?? '',
          body: '',
          attachmentIDs: [],
          notify: false,
        }),
      });
    },
    onSuccess: (_data, scope) => {
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => old?.filter((d) => !sameDraftScope(d, scope)),
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
            url: att.url,
            squareThumbnailURL: att.squareThumbnailURL,
            progress: 1,
          };
        })
        .filter((att): att is DraftAttachment => att !== null),
    [ids, map],
  );
}
