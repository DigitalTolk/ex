import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// The action context (openTag) is stable across the provider's lifetime
// and is consumed by every rendered MessageItem. The state context
// (activeTag + closeTag) changes whenever a tag is opened or closed
// and is consumed only by the panel. Splitting them keeps tag clicks
// from re-rendering the entire message list.
interface TagOpenValue {
  openTag: (tag: string) => void;
}
interface TagStateValue {
  activeTag: string | null;
  // tagNonce bumps on every openTag call (even for the same tag) so a
  // re-click forces consumers to invalidate cached search results.
  tagNonce: number;
  closeTag: () => void;
}

const TagOpenContext = createContext<TagOpenValue | undefined>(undefined);
const TagStateContext = createContext<TagStateValue | undefined>(undefined);

export function TagSearchProvider({ children, initialTag = null }: { children: ReactNode; initialTag?: string | null }) {
  const [state, setState] = useState<{ tag: string | null; nonce: number }>({
    tag: initialTag,
    nonce: 0,
  });
  const openTag = useCallback(
    (tag: string) => setState((prev) => ({ tag, nonce: prev.nonce + 1 })),
    [],
  );
  const closeTag = useCallback(
    () => setState((prev) => ({ tag: null, nonce: prev.nonce })),
    [],
  );
  const openValue = useMemo<TagOpenValue>(() => ({ openTag }), [openTag]);
  const stateValue = useMemo<TagStateValue>(
    () => ({ activeTag: state.tag, tagNonce: state.nonce, closeTag }),
    [state.tag, state.nonce, closeTag],
  );
  return (
    <TagOpenContext.Provider value={openValue}>
      <TagStateContext.Provider value={stateValue}>{children}</TagStateContext.Provider>
    </TagOpenContext.Provider>
  );
}

const NOOP_OPEN: TagOpenValue = { openTag: () => {} };
const NOOP_STATE: TagStateValue = { activeTag: null, tagNonce: 0, closeTag: () => {} };

export function useTagOpen(): TagOpenValue {
  return useContext(TagOpenContext) ?? NOOP_OPEN;
}

export function useTagState(): TagStateValue {
  return useContext(TagStateContext) ?? NOOP_STATE;
}
