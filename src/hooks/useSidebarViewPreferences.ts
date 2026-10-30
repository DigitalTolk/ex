import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { readString, writeString } from '@/lib/storage';
import { markLocalUserStateWrite, useUserState } from '@/hooks/useUserState';
import { SidebarSectionKeys, type ConversationSidebarSort, type SectionSort } from '@/lib/sidebar-groups';
import type { UserState } from '@/types';

// Sidebar view preferences. Each section's sort is the user's, on every
// device: it lives in their user state on the server (sidebarSorts), which
// the app loads once at start like the rest of the user state — no request of
// its own. This device keeps a copy (sidebar.sectionSorts), so the sidebar
// opens in the right order before the user state arrives. The two
// unread views (both default off) and which sections are folded are per
// device. Storage goes through @/lib/storage, so a blocked localStorage
// (private mode, disabled site data) only means the choice is not remembered
// — the sidebar still renders and the toggles still apply.
//
// Direct Messages' sort was once per device: until the user picks one again,
// the order this device remembers (sidebar.conversationSort) still applies.
const CONVERSATION_SORT_STORAGE_KEY = 'sidebar.conversationSort';
const SECTION_SORTS_STORAGE_KEY = 'sidebar.sectionSorts';
const UNREAD_SECTION_STORAGE_KEY = 'sidebar.unreadSection';
const UNREAD_ONLY_STORAGE_KEY = 'sidebar.unreadOnly';
const COLLAPSED_SECTIONS_STORAGE_KEY = 'sidebar.collapsedSections';

function usePersisted<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string) {
  const [value, setValue] = useState(() => parse(readString(key)));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeString(key, serialize(next));
    },
    [key, serialize],
  );
  return [value, set] as const;
}

const parseSort = (raw: string | null): ConversationSidebarSort => (raw === 'az' ? 'az' : 'recent');
const NO_SORTS: Record<string, SectionSort> = {};

// The copy of the saved sorts: anything unreadable is no copy at all.
function parseSorts(raw: string | null): Record<string, SectionSort> {
  let sorts: unknown;
  try {
    sorts = JSON.parse(raw ?? '{}');
  } catch {
    return NO_SORTS;
  }
  if (!sorts || typeof sorts !== 'object' || Array.isArray(sorts)) return NO_SORTS;
  return Object.fromEntries(
    Object.entries(sorts).filter((entry): entry is [string, SectionSort] => entry[1] === 'recent' || entry[1] === 'az'),
  );
}
const serializeSorts = (sorts: Record<string, SectionSort>) => JSON.stringify(sorts);
const sameSorts = (a: Record<string, SectionSort>, b: Record<string, SectionSort>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);
const parseFlag = (raw: string | null) => raw === '1';
const serializeFlag = (on: boolean) => (on ? '1' : '0');

// Folded sections are stored as the list of their keys: a category's ID or a
// built-in section's key. Anything unreadable leaves every section open.
function parseCollapsed(raw: string | null): Record<string, boolean> {
  let keys: unknown = [];
  try {
    keys = JSON.parse(raw ?? '[]');
  } catch {
    // keep the empty list
  }
  if (!Array.isArray(keys)) return {};
  return Object.fromEntries(keys.filter((key) => typeof key === 'string').map((key) => [key, true]));
}
const serializeCollapsed = (collapsed: Record<string, boolean>) =>
  JSON.stringify(Object.keys(collapsed).filter((key) => collapsed[key]));

export function useSidebarViewPreferences() {
  const qc = useQueryClient();
  const userStateQuery = useUserState();
  const userState = userStateQuery.data;
  // Until the user state arrives (only a placeholder so far), this device's
  // copy stands in; once it has, the copy follows it.
  const loaded = userState !== undefined && !userStateQuery.isPlaceholderData;
  const [deviceSorts, setDeviceSorts] = usePersisted(SECTION_SORTS_STORAGE_KEY, parseSorts, serializeSorts);
  const loadedSorts = loaded ? (userState.sidebarSorts ?? NO_SORTS) : undefined;
  const serverSorts = loadedSorts ?? deviceSorts;
  useEffect(() => {
    if (loadedSorts && !sameSorts(loadedSorts, deviceSorts)) setDeviceSorts(loadedSorts);
  }, [loadedSorts, deviceSorts, setDeviceSorts]);
  // A sort just chosen shows at once and stands while its save is on the way.
  const [pending, setPending] = useState<Record<string, SectionSort>>(NO_SORTS);
  // The latest save per section: an earlier one that lands after it must not
  // undo it.
  const latestSave = useRef(new Map<string, number>());
  const savedSorts = useMemo(
    () => (Object.keys(pending).length === 0 ? serverSorts : { ...serverSorts, ...pending }),
    [serverSorts, pending],
  );
  // Only read now: a DM sort chosen today is saved for the user.
  const [deviceConversationSort] = useState(() => parseSort(readString(CONVERSATION_SORT_STORAGE_KEY)));
  const conversationSort = savedSorts[SidebarSectionKeys.DirectMessages] ?? deviceConversationSort;
  // Every section but Direct Messages, which groupSidebarItems sorts by
  // conversationSort.
  const sectionSorts = useMemo(
    () => Object.fromEntries(Object.entries(savedSorts).filter(([key]) => key !== SidebarSectionKeys.DirectMessages)),
    [savedSorts],
  );
  const [unreadSection, setUnreadSection] = usePersisted(UNREAD_SECTION_STORAGE_KEY, parseFlag, serializeFlag);
  const [unreadOnly, setUnreadOnly] = usePersisted(UNREAD_ONLY_STORAGE_KEY, parseFlag, serializeFlag);
  const [collapsedSections, setCollapsedSections] = usePersisted(
    COLLAPSED_SECTIONS_STORAGE_KEY,
    parseCollapsed,
    serializeCollapsed,
  );
  const toggleSectionCollapsed = (key: string) =>
    setCollapsedSections({ ...collapsedSections, [key]: !collapsedSections[key] });
  // Direct Messages defaults to 'recent', every other section to 'az'.
  const sectionSort = (key: string): SectionSort =>
    key === SidebarSectionKeys.DirectMessages ? conversationSort : (sectionSorts[key] ?? 'az');
  // Saved, it goes straight into the user state this tab holds (and so into
  // the device copy) — the server's "user state changed" echo of our own write
  // is skipped rather than refetching all of it. A failed save drops the
  // pending choice and refetches what the server has.
  const setSectionSort = (key: string, sort: SectionSort) => {
    if (sectionSort(key) === sort) return;
    const save = (latestSave.current.get(key) ?? 0) + 1;
    latestSave.current.set(key, save);
    const isLatest = () => latestSave.current.get(key) === save;
    const dropPending = () =>
      setPending((current) => Object.fromEntries(Object.entries(current).filter(([pendingKey]) => pendingKey !== key)));
    setPending((current) => ({ ...current, [key]: sort }));
    markLocalUserStateWrite();
    apiFetch<void>(`/api/v1/user-state/sidebar-sorts/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ sort }),
    }).then(
      () => {
        if (!isLatest()) return;
        if (loaded) {
          // Loaded, so the user state is in the cache.
          qc.setQueryData<UserState>(queryKeys.userState(), (old) => ({
            ...old!,
            sidebarSorts: { ...old!.sidebarSorts, [key]: sort },
          }));
        } else {
          setDeviceSorts({ ...deviceSorts, [key]: sort });
        }
        dropPending();
      },
      () => {
        if (!isLatest()) return;
        dropPending();
        void qc.invalidateQueries({ queryKey: queryKeys.userState() });
      },
    );
  };
  return {
    conversationSort,
    sectionSorts,
    sectionSort,
    setSectionSort,
    unreadSection,
    setUnreadSection,
    unreadOnly,
    setUnreadOnly,
    collapsedSections,
    toggleSectionCollapsed,
  };
}
