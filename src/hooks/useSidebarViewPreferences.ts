import { useCallback, useState } from 'react';
import { readString, writeString } from '@/lib/storage';
import type { ConversationSidebarSort } from '@/lib/sidebar-groups';

// Per-device sidebar view preferences: the DM sort and the two unread views
// (both default off). Storage goes through @/lib/storage, so a blocked
// localStorage (private mode, disabled site data) only means the choice is
// not remembered — the sidebar still renders and the toggles still apply.
const CONVERSATION_SORT_STORAGE_KEY = 'sidebar.conversationSort';
const UNREAD_SECTION_STORAGE_KEY = 'sidebar.unreadSection';
const UNREAD_ONLY_STORAGE_KEY = 'sidebar.unreadOnly';

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

export function useSidebarViewPreferences() {
  const [conversationSort, setConversationSort] = usePersisted(CONVERSATION_SORT_STORAGE_KEY, parseSort, serializeSort);
  const [unreadSection, setUnreadSection] = usePersisted(UNREAD_SECTION_STORAGE_KEY, parseFlag, serializeFlag);
  const [unreadOnly, setUnreadOnly] = usePersisted(UNREAD_ONLY_STORAGE_KEY, parseFlag, serializeFlag);
  return { conversationSort, setConversationSort, unreadSection, setUnreadSection, unreadOnly, setUnreadOnly };
}
