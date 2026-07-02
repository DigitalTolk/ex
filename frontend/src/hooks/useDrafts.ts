import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
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
  // ts is the client edit time (epoch ms). The backend orders saves vs the
  // send-fold delete by this, last-write-wins, so a delayed keystroke can't
  // resurrect a sent draft. Omitted → the server uses its own clock.
  ts?: number;
}

const suppressedSentDraftScopes = new Set<string>();
const draftMutationVersions = new Map<string, number>();
const LOCAL_DRAFT_EVENT_IGNORE_MS = 1500;
let ignoreDraftEventsUntil = 0;

function draftScopeKey(scope: DraftScope): string {
  return `${scope.parentType}:${scope.parentID ?? ''}:${scope.parentMessageID ?? ''}`;
}

// resetDraftSessionState clears the process-wide draft bookkeeping (sent-scope
// suppression + per-scope mutation versions). Called on logout so a different
// user signing in within the same document can't inherit the prior session's
// draft state, and so the maps don't grow unbounded across long sessions.
export function resetDraftSessionState() {
  suppressedSentDraftScopes.clear();
  draftMutationVersions.clear();
  ignoreDraftEventsUntil = 0;
}

// isScopeSuppressed reports whether a scope was just sent (so any draft for it
// should be cleared, not surfaced). Restored when the user types new content.
// A MessageDraft is a valid DraftScope (shares parentID/parentType/parentMessageID).
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

// markLocalDraftClearForSend arms the same "ignore our own draft.updated
// echo" window the draft mutations use. Called by useSendMessage at MUTATE
// time: the server folds the draft-clear into message creation and
// publishes the echo while the POST is still in flight, so arming the
// window in the views' onSuccess clearDraftMutate was too late — the echo
// raced it and triggered a full /drafts refetch on every send.
export function markLocalDraftClearForSend() {
  markLocalDraftDelete();
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
  if (!draft || isScopeSuppressed(draft)) return withoutScope;
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
      return Array.isArray(res) ? res.filter((draft) => !isScopeSuppressed(draft)) : [];
    },
    enabled: options?.enabled ?? true,
    staleTime: 15_000,
  });
}

export function useDraftForScope(scope: DraftScope) {
  const drafts = useDrafts();
  return { ...drafts, data: findDraftByScope(drafts.data, scope) };
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
          ts: input.ts,
        }),
      });
    },
    onMutate: (input) => nextDraftMutationVersion(input),
    onSuccess: (draft, input, ctx) => {
      /* istanbul ignore next -- ctx is always set: onMutate unconditionally returns the version object */
      if (!ctx) return;
      if (!isLatestDraftMutation(ctx.key, ctx.version)) return;
      // The scope was just sent: the server's send-fold already cleared it
      // (last-write-wins drops this stale save), so don't re-surface it in the
      // cache. Restored when the user types new content (un-suppresses).
      if (isScopeSuppressed(input)) return;
      // Silent (keystroke) saves persist server-side but must not surface the
      // draft in the sidebar yet — leave the local list untouched so the
      // indicator stays hidden until the non-silent focus-loss save patches it.
      // EXCEPTION: a silent save that empties the draft is a *removal*, never a
      // surface — patch it through immediately so clearing the composer drops
      // the sidebar badge at once, instead of lingering until focus loss /
      // channel switch (the server already deleted it, returning a nil draft).
      const isEmptyDraft = input.body === '' && (input.attachmentIDs?.length ?? 0) === 0;
      if (input.silent && !isEmptyDraft) return;
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => patchDraftListByScope(old, input, draft ?? null),
      );
    },
  });
}

// useClearDraftForScope returns a function that drops a sent scope's draft from
// the LOCAL cache for an instant UI update. The SERVER-side delete is folded
// into the message-send call (the backend clears the draft as it creates the
// message, ordered by client ts last-write-wins), so this makes NO network
// request — it's a plain cache patch, not a mutation.
export function useClearDraftForScope() {
  const qc = useQueryClient();
  return useCallback(
    (scope: DraftScope) => {
      // Ignore the server's resulting draft.updated echo, then optimistically
      // remove the scope so the sidebar / Drafts page update without waiting.
      markLocalDraftDelete();
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => old?.filter((d) => !sameDraftScope(d, scope)),
      );
    },
    [qc],
  );
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
