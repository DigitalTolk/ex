import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';
import { ApiError, apiFetch } from '@/lib/api';
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
  // Teardown flush (pagehide): send with fetch keepalive so the request
  // survives the tab closing instead of dying with the page.
  keepalive?: boolean;
}

// ---------------------------------------------------------------------------
// Session protocol state.
//
// The SERVER owns draft ordering: every stored draft carries a server-minted
// generation, and a save or clear is accepted only when it presents the
// generation it acted on (its basis; "" = "no draft exists"). A stale writer
// gets a 409 with the current state and reconciles. The maps below are the
// client's half of that protocol — protocol state, not heuristics:
//
//   draftBasisGens      scopeKey → the generation this session is acting on
//   condemnedDraftGens  generations killed by a send (its server-side fold is
//                       async, so a racing refetch can briefly resurface them)
//   draftMutationVersions  per-scope guard so an out-of-order save response or
//                          conflict can't regress newer state
// ---------------------------------------------------------------------------

const draftBasisGens = new Map<string, string>();
const condemnedDraftGens = new Set<string>();
const draftMutationVersions = new Map<string, number>();
const LOCAL_DRAFT_EVENT_IGNORE_MS = 1500;
let ignoreDraftEventsUntil = 0;

function draftScopeKey(scope: DraftScope): string {
  return `${scope.parentType}:${scope.parentID ?? ''}:${scope.parentMessageID ?? ''}`;
}

// resetDraftSessionState clears the process-wide draft protocol state. Called
// on logout so a different user signing in within the same document can't
// inherit the prior session's bases, and so the maps don't grow unbounded
// across long sessions.
export function resetDraftSessionState() {
  draftBasisGens.clear();
  condemnedDraftGens.clear();
  draftMutationVersions.clear();
  ignoreDraftEventsUntil = 0;
}

// draftBasisFor returns the generation this session is acting on for a scope
// ("" = it believes no draft exists). Saves and clears present it to the
// server, which decides whether the write applies.
export function draftBasisFor(scope: DraftScope): string {
  return draftBasisGens.get(draftScopeKey(scope)) ?? '';
}

// adoptDraftBasis records the generation this session now acts on for a scope
// — from cache hydration, a save response, or a 409's current state.
export function adoptDraftBasis(scope: DraftScope, gen: string | undefined) {
  draftBasisGens.set(draftScopeKey(scope), gen ?? '');
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
  if (!draft) return withoutScope;
  return [draft, ...withoutScope];
}

// removeDraftScopeFromCache drops a scope's draft from the local cache for an
// instant UI update. Used by the message-send path: the SERVER-side clear is
// folded into the send itself (unconditional), so this is a plain cache
// patch, not a request.
export function removeDraftScopeFromCache(qc: QueryClient, scope: DraftScope) {
  qc.setQueryData<MessageDraft[]>(
    queryKeys.drafts(),
    (old) => old?.filter((d) => !sameDraftScope(d, scope)),
  );
}

// condemnDraftForSend marks a scope's draft as killed by a message send. The
// send folds an UNCONDITIONAL server-side clear (sending is the authoritative
// event for the scope), but that fold is async — so the current generation is
// condemned (a racing /drafts refetch briefly returning it is filtered), the
// session basis resets to "no draft", and in-flight save mutations are
// outdated so their late responses or conflicts can't resurrect anything.
// Returns a rollback for failed sends (the fold never ran).
export function condemnDraftForSend(scope: DraftScope): () => void {
  const key = draftScopeKey(scope);
  const gen = draftBasisGens.get(key) ?? '';
  nextDraftMutationVersion(scope);
  markLocalDraftDelete();
  if (gen !== '') condemnedDraftGens.add(gen);
  draftBasisGens.set(key, '');
  return () => {
    if (gen !== '') condemnedDraftGens.delete(gen);
    draftBasisGens.set(key, gen);
  };
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

// draftConflictCurrent returns the server's current draft (null = the scope
// has no draft) when the error is a draft-conflict 409, undefined otherwise.
function draftConflictCurrent(error: unknown): MessageDraft | null | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const payload = error.payload as
    | { error?: { code?: string }; current?: MessageDraft | null }
    | undefined;
  if (payload?.error?.code !== 'draft_conflict') return undefined;
  return payload.current ?? null;
}

export function useDrafts(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.drafts(),
    queryFn: async () => {
      const res = await apiFetch<MessageDraft[]>('/api/v1/drafts');
      // Drop rows whose generation a send has condemned: the send's
      // server-side fold is async, so a refetch racing it can briefly return
      // the just-sent draft. Keyed by GENERATION — a new draft in the same
      // scope carries a fresh gen and is never filtered.
      return Array.isArray(res) ? res.filter((draft) => !condemnedDraftGens.has(draft.gen)) : [];
    },
    enabled: options?.enabled ?? true,
    staleTime: 15_000,
  });
}

export function useDraftForScope(scope: DraftScope) {
  const drafts = useDrafts();
  const draft = findDraftByScope(drafts.data, scope);
  const key = draftScopeKey(scope);
  const gen = draft?.gen ?? '';
  const loaded = drafts.data !== undefined;
  // The composer displaying this scope acts on what the cache (server truth)
  // shows it — keep the session basis in lockstep. Before the first fetch
  // resolves the cache says nothing, so the basis is left alone.
  useEffect(() => {
    if (!loaded) return;
    draftBasisGens.set(key, gen);
  }, [key, gen, loaded]);
  return { ...drafts, data: draft };
}

export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveDraftInput) => {
      const attachmentIDs = input.attachmentIDs ?? [];
      const basisGen = draftBasisFor(input);
      const existing = findDraftByScope(qc.getQueryData<MessageDraft[]>(queryKeys.drafts()), input);
      const isEmpty = input.body === '' && attachmentIDs.length === 0;
      // A clean session flushing an empty composer over a scope it believes
      // (and the cache agrees) has no draft: nothing to report. Every OTHER
      // empty save IS sent — whether it clears anything is the server's
      // decision. (Deciding from the local cache alone used to strand
      // silently-saved drafts server-side, resurrecting them later.)
      if (isEmpty && basisGen === '' && !existing) {
        return Promise.resolve(undefined);
      }
      // Identical content on the exact generation we're acting on: no-op
      // (channel-switch flushes of an untouched hydrated draft).
      if (
        existing &&
        existing.gen === basisGen &&
        existing.body === input.body &&
        sameAttachmentIDs(existing.attachmentIDs, attachmentIDs)
      ) {
        return Promise.resolve(existing);
      }
      return apiFetch<MessageDraft | void>('/api/v1/drafts', {
        method: 'PUT',
        keepalive: input.keepalive,
        body: JSON.stringify({
          parentID: input.parentID,
          parentType: input.parentType,
          parentMessageID: input.parentMessageID ?? '',
          body: input.body,
          attachmentIDs,
          notify: !input.silent,
          basisGen,
        }),
      });
    },
    onMutate: (input) => nextDraftMutationVersion(input),
    onSuccess: (draft, input, ctx) => {
      /* istanbul ignore next -- ctx is always set: onMutate unconditionally returns the version object */
      if (!ctx) return;
      if (!isLatestDraftMutation(ctx.key, ctx.version)) return;
      // The write was accepted: this session now acts on the generation the
      // server minted for it ("" when the save was a clear/no-op).
      adoptDraftBasis(input, draft?.gen);
      // Silent (keystroke) saves persist server-side but must not surface the
      // draft in the sidebar yet — leave the local list untouched so the
      // indicator stays hidden until the non-silent focus-loss save patches it.
      // EXCEPTION: a silent save that empties the draft is a *removal*, never a
      // surface — patch it through immediately so clearing the composer drops
      // the sidebar badge at once (the server already deleted it).
      const isEmptyDraft = input.body === '' && (input.attachmentIDs?.length ?? 0) === 0;
      if (input.silent && !isEmptyDraft) return;
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => patchDraftListByScope(old, input, draft ?? null),
      );
    },
    onError: (error, input, ctx) => {
      /* istanbul ignore next -- ctx is always set: onMutate unconditionally returns the version object */
      if (!ctx) return;
      // A newer local action (edit, send) has already superseded this write —
      // its conflict is history; reconciling would resurrect stale state.
      if (!isLatestDraftMutation(ctx.key, ctx.version)) return;
      const current = draftConflictCurrent(error);
      if (current === undefined) return; // network/server error: next flush retries
      // The server refused: this session acted on stale state. Adopt the
      // truth — basis and cache. The composer mirrors the cache while the
      // user isn't actively editing, so the surviving draft (or its absence)
      // surfaces; if the user IS typing, their very next save/flush presents
      // the adopted basis and wins as a deliberate overwrite.
      adoptDraftBasis(input, current?.gen);
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => patchDraftListByScope(old, input, current),
      );
    },
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    onMutate: markLocalDraftDelete,
    // The Drafts page deletes the exact row it displayed — the generation
    // rides along so a stale page can't remove a draft that changed since
    // it rendered (the server answers 409 instead).
    mutationFn: (draft: Pick<MessageDraft, 'id' | 'gen'>) =>
      apiFetch<void>(`/api/v1/drafts/${draft.id}?gen=${encodeURIComponent(draft.gen)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, draft) => {
      qc.setQueryData<MessageDraft[]>(
        queryKeys.drafts(),
        (old) => old?.filter((item) => item.id !== draft.id),
      );
    },
    onError: (error) => {
      // Conflict: the draft changed under the page — refetch the truth so
      // the list re-renders with the current row.
      if (draftConflictCurrent(error) !== undefined) {
        void qc.invalidateQueries({ queryKey: queryKeys.drafts() });
      }
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
