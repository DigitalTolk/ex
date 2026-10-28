import { useCallback, useState } from 'react';
import { readString, writeString } from '@/lib/storage';
import type { ConversationSidebarSort } from '@/lib/sidebar-groups';

// Per-device sidebar view preferences: the DM sort, the two unread views
// (both default off) and which sections are folded. Storage goes through @/lib/storage, so a blocked
// localStorage (private mode, disabled site data) only means the choice is
// not remembered — the sidebar still renders and the toggles still apply.
const CONVERSATION_SORT_STORAGE_KEY = 'sidebar.conversationSort';
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
const serializeSort = (sort: ConversationSidebarSort) => sort;
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
  const [conversationSort, setConversationSort] = usePersisted(CONVERSATION_SORT_STORAGE_KEY, parseSort, serializeSort);
  const [unreadSection, setUnreadSection] = usePersisted(UNREAD_SECTION_STORAGE_KEY, parseFlag, serializeFlag);
  const [unreadOnly, setUnreadOnly] = usePersisted(UNREAD_ONLY_STORAGE_KEY, parseFlag, serializeFlag);
  const [collapsedSections, setCollapsedSections] = usePersisted(
    COLLAPSED_SECTIONS_STORAGE_KEY,
    parseCollapsed,
    serializeCollapsed,
  );
  const toggleSectionCollapsed = (key: string) =>
    setCollapsedSections({ ...collapsedSections, [key]: !collapsedSections[key] });
  return {
    conversationSort,
    setConversationSort,
    unreadSection,
    setUnreadSection,
    unreadOnly,
    setUnreadOnly,
    collapsedSections,
    toggleSectionCollapsed,
  };
}
