import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { SidebarReorderUpdate } from '@/lib/sidebar-reorder';
import type { SidebarCategory, UserChannel, UserConversation } from '@/types';

// SidebarItemKind selects whether a sidebar attribute mutation targets a
// channel or a conversation. The two paths differ only in URL prefix
// and which React Query cache they invalidate; everything else is shared.
type SidebarItemKind = 'channel' | 'conversation';

const URL_PREFIX: Record<SidebarItemKind, string> = {
  channel: '/api/v1/channels',
  conversation: '/api/v1/conversations',
};

const INVALIDATE_KEY: Record<SidebarItemKind, readonly string[]> = {
  channel: queryKeys.userChannels(),
  conversation: queryKeys.userConversations(),
};

type SidebarAttrRow = UserChannel | UserConversation;
type SidebarAttrMutationVars = { id: string; body: Record<string, unknown> };

/* v8 ignore start -- opt-in browser diagnostics, not production behavior. */
const SIDEBAR_DND_DEBUG_STORAGE_KEY = 'ex.sidebarDndDebug';

function sidebarDndDebugEnabled(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_DND_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function sidebarDndDebug(event: string, details?: Record<string, unknown>) {
  if (!sidebarDndDebugEnabled()) return;
  /* istanbul ignore next -- every call site passes a details object, so the ?? {} fallback arm is dead defensive code */
  console.debug(`[sidebar-dnd] ${event}`, details ?? {});
}

function sidebarDndDebugError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}
/* v8 ignore stop */

function sidebarAttrRowID(kind: SidebarItemKind, row: SidebarAttrRow): string {
  return kind === 'channel'
    ? (row as UserChannel).channelID
    : (row as UserConversation).conversationID;
}

function optimisticSidebarAttr(body: Record<string, unknown>): Partial<SidebarAttrRow> {
  const next: Partial<SidebarAttrRow> = {};
  if (typeof body.favorite === 'boolean') next.favorite = body.favorite;
  if (typeof body.categoryID === 'string') next.categoryID = body.categoryID;
  if (typeof body.sidebarPosition === 'number') next.sidebarPosition = body.sidebarPosition;
  return next;
}

// useCategories returns the user's sidebar categories.
export function useCategories(options?: { enabled?: boolean }) {
  return useQuery<SidebarCategory[]>({
    queryKey: queryKeys.sidebarCategories(),
    queryFn: async () => {
      const res = await apiFetch<SidebarCategory[]>('/api/v1/sidebar/categories');
      return Array.isArray(res) ? res : [];
    },
    enabled: options?.enabled ?? true,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sidebarCategories() }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  const queryKey = queryKeys.sidebarCategories();
  return useMutation({
    mutationFn: (vars: { id: string; name?: string; position?: number }) => {
      sidebarDndDebug('category-api PATCH start', vars);
      return apiFetch<SidebarCategory>(`/api/v1/sidebar/categories/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: vars.name, position: vars.position }),
      });
    },
    onMutate: async (vars) => {
      sidebarDndDebug('category-cache onMutate start', vars);
      const previous = qc.getQueryData<SidebarCategory[]>(queryKey);
      qc.setQueryData<SidebarCategory[]>(queryKey, (current) =>
        current?.map((category) =>
          category.id === vars.id
            ? {
                ...category,
                ...(vars.name !== undefined ? { name: vars.name } : {}),
                ...(vars.position !== undefined ? { position: vars.position } : {}),
              }
            : category,
        ) ?? current,
      );
      sidebarDndDebug('category-cache optimistic applied', {
        vars,
        previous,
        next: qc.getQueryData<SidebarCategory[]>(queryKey),
      });
      await qc.cancelQueries({ queryKey });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      sidebarDndDebug('category-cache onError rollback', {
        vars: _vars,
        error: sidebarDndDebugError(_err),
        previous: context?.previous,
      });
      qc.setQueryData(queryKey, context?.previous);
    },
    onSuccess: (data, vars) => {
      sidebarDndDebug('category-api PATCH success', { vars, data });
    },
    onSettled: (_data, _error, vars) => {
      sidebarDndDebug('category-cache invalidate', {
        vars,
        error: sidebarDndDebugError(_error),
      });
      qc.invalidateQueries({ queryKey });
    },
  });
}

export function useReorderCategories() {
  const qc = useQueryClient();
  const queryKey = queryKeys.sidebarCategories();
  return useMutation({
    mutationFn: async (vars: { categories: SidebarCategory[] }) => {
      const changed = vars.categories.map((category, index) => ({
        ...category,
        position: (index + 1) * 1000,
      }));
      sidebarDndDebug('category-api reorder start', {
        order: changed.map((category) => ({ id: category.id, position: category.position })),
      });
      await Promise.all(
        changed.map((category) =>
          apiFetch<SidebarCategory>(`/api/v1/sidebar/categories/${category.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: undefined, position: category.position }),
          }),
        ),
      );
      return changed;
    },
    onMutate: async (vars) => {
      // Initiate cancellation synchronously, then patch SYNCHRONOUSLY (before the
      // await) so the reorder commits with the drop — same fix as the channel/DM
      // reorder above; a patch behind the await snap-back-flashes the old order.
      const cancelled = qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<SidebarCategory[]>(queryKey);
      const next = vars.categories.map((category, index) => ({
        ...category,
        position: (index + 1) * 1000,
      }));
      qc.setQueryData<SidebarCategory[]>(queryKey, next);
      sidebarDndDebug('category-cache reorder optimistic applied', {
        previous,
        next: next.map((category) => ({ id: category.id, position: category.position })),
      });
      await cancelled;
      return { previous };
    },
    onError: (_err, _vars, context) => {
      sidebarDndDebug('category-cache reorder rollback', {
        error: sidebarDndDebugError(_err),
        previous: context?.previous,
      });
      qc.setQueryData(queryKey, context?.previous);
    },
    onSuccess: (data) => {
      sidebarDndDebug('category-api reorder success', {
        order: data.map((category) => ({ id: category.id, position: category.position })),
      });
    },
    // Deliberately NO post-write invalidate. The category list read is eventually
    // consistent (no ConsistentRead), so a read-after-write refetch here races
    // the write and can momentarily return the OLD order — reverting the drop
    // (a snap-back). The optimistic order already equals what we persisted; the
    // next natural refetch (staleTime/focus/remount) reconciles. Mirrors
    // useReorderSidebar, which dropped its post-write invalidate for the same reason.
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/v1/sidebar/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sidebarCategories() });
      // Channels and DMs assigned to a deleted category fall back to
      // their default sections; the user-side rows still carry the
      // (now-stale) categoryID, so refetch both lists.
      qc.invalidateQueries({ queryKey: queryKeys.userChannels() });
      qc.invalidateQueries({ queryKey: queryKeys.userConversations() });
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
    mutationFn: (vars: SidebarAttrMutationVars) =>
      apiFetch(`${URL_PREFIX[kind]}/${vars.id}/${attr}`, {
        method: 'PUT',
        body: JSON.stringify(vars.body),
      }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: invalidateKey });
      const previous = qc.getQueryData<SidebarAttrRow[]>(invalidateKey);
      const optimistic = optimisticSidebarAttr(vars.body);
      qc.setQueryData<SidebarAttrRow[]>(invalidateKey, (current) =>
        current?.map((row) =>
          sidebarAttrRowID(kind, row) === vars.id
            ? { ...row, ...optimistic }
            : row,
        ) ?? current,
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      qc.setQueryData(invalidateKey, context?.previous);
    },
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
    mutate: (vars: { channelID: string; categoryID: string; sidebarPosition?: number }) => {
      const body: { categoryID: string; sidebarPosition?: number } = { categoryID: vars.categoryID };
      if (vars.sidebarPosition !== undefined) body.sidebarPosition = vars.sidebarPosition;
      return m.mutate({ id: vars.channelID, body });
    },
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
    mutate: (vars: { conversationID: string; categoryID: string; sidebarPosition?: number }) => {
      const body: { categoryID: string; sidebarPosition?: number } = { categoryID: vars.categoryID };
      if (vars.sidebarPosition !== undefined) body.sidebarPosition = vars.sidebarPosition;
      return m.mutate({ id: vars.conversationID, body });
    },
  };
}

// "Ignore our own sidebar-reorder echo" window, mirroring the drafts/user-state
// pattern. A reorder writes N per-item rows, each publishing a
// `userchannel.updated` event back to the acting user; without this window
// ChatPage.onUserChannelUpdated would refetch userChannels once per item — and
// each refetch is an eventually-consistent DynamoDB read that can return the
// PRE-reorder order and clobber the (authoritative) optimistic update. The
// window suppresses those self-echoes; the optimistic cache is the truth (we
// wrote exactly those positions), so no post-write refetch is needed. Other
// tabs never arm the window and still reconcile.
const LOCAL_SIDEBAR_REORDER_IGNORE_MS = 2000;
let ignoreSidebarReorderEventsUntil = 0;

export function markLocalSidebarReorder() {
  ignoreSidebarReorderEventsUntil = Date.now() + LOCAL_SIDEBAR_REORDER_IGNORE_MS;
}

export function shouldRefetchSidebarForRemoteUpdate(): boolean {
  return Date.now() >= ignoreSidebarReorderEventsUntil;
}

export function resetSidebarReorderSessionState() {
  ignoreSidebarReorderEventsUntil = 0;
}

// applyReorderOptimistic patches one list cache in place: for every affected
// row, set its new category/favorite/position. The render sort re-orders from
// these, so the dropped item lands exactly where released — no refetch.
function applyReorderOptimistic(
  rows: SidebarAttrRow[] | undefined,
  kind: SidebarItemKind,
  byID: Map<string, SidebarReorderUpdate>,
): SidebarAttrRow[] | undefined {
  if (!rows) return rows;
  return rows.map((row) => {
    const upd = byID.get(sidebarAttrRowID(kind, row));
    if (!upd) return row;
    return { ...row, categoryID: upd.categoryID, favorite: upd.favorite, sidebarPosition: upd.sidebarPosition };
  });
}

// useReorderSidebar persists a whole drop: the dense-positioned updates from
// computeSidebarReorder. It writes each row through the existing per-item
// endpoints (category+position always; favorite only when it flipped), applies
// an authoritative optimistic patch to BOTH list caches, rolls back on error,
// and deliberately does NOT invalidate afterward (the optimistic state already
// equals what we wrote — a read-after-write refetch here is exactly what caused
// the snap-back).
export function useReorderSidebar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { updates: SidebarReorderUpdate[]; favoriteChanged: Set<string> }) => {
      await Promise.all(
        vars.updates.map((u) => {
          const prefix = URL_PREFIX[u.kind];
          const writes: Promise<unknown>[] = [
            apiFetch(`${prefix}/${u.id}/category`, {
              method: 'PUT',
              body: JSON.stringify({ categoryID: u.categoryID, sidebarPosition: u.sidebarPosition }),
            }),
          ];
          // Favorite lives on a separate endpoint; only touch it for the row
          // whose favorite actually flipped (a cross-section move in/out of
          // Favorites), never for the untouched neighbors being re-spaced.
          if (vars.favoriteChanged.has(u.id)) {
            writes.push(
              apiFetch(`${prefix}/${u.id}/favorite`, {
                method: 'PUT',
                body: JSON.stringify({ favorite: u.favorite }),
              }),
            );
          }
          return Promise.all(writes);
        }),
      );
    },
    onMutate: async (vars) => {
      markLocalSidebarReorder();
      const channelKey = queryKeys.userChannels();
      const convKey = queryKeys.userConversations();
      // Initiate cancellation of any in-flight list refetch SYNCHRONOUSLY (the
      // abort fires now; the promise only resolves once they unwind). Doing this
      // before the patch means no late refetch can clobber the optimistic state.
      const cancelled = Promise.all([
        qc.cancelQueries({ queryKey: channelKey }),
        qc.cancelQueries({ queryKey: convKey }),
      ]);
      const previousChannels = qc.getQueryData<SidebarAttrRow[]>(channelKey);
      const previousConversations = qc.getQueryData<SidebarAttrRow[]>(convKey);
      const byID = new Map(vars.updates.map((u) => [u.id, u] as const));
      // Patch BOTH caches SYNCHRONOUSLY — before any `await` — so the optimistic
      // reorder commits in the SAME React pass as the drop clearing the gap and
      // the dragged row's dim. Behind an await it landed one microtask (one
      // commit) later, so the row painted a frame at its OLD slot on release,
      // which read as a snap-back animation. Not a transition — a two-commit race.
      qc.setQueryData<SidebarAttrRow[]>(channelKey, (rows) => applyReorderOptimistic(rows, 'channel', byID));
      qc.setQueryData<SidebarAttrRow[]>(convKey, (rows) => applyReorderOptimistic(rows, 'conversation', byID));
      sidebarDndDebug('reorder optimistic applied', { updates: vars.updates });
      await cancelled;
      return { previousChannels, previousConversations };
    },
    onError: (_err, _vars, context) => {
      sidebarDndDebug('reorder rollback', { error: sidebarDndDebugError(_err) });
      if (context?.previousChannels) qc.setQueryData(queryKeys.userChannels(), context.previousChannels);
      if (context?.previousConversations) qc.setQueryData(queryKeys.userConversations(), context.previousConversations);
    },
  });
}
