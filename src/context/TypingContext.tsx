import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import {
  clearTyping,
  recordTyping,
  setSelfUserID,
  stopTypingExpiryTimer,
  threadTypingKey,
  useTypingStore,
} from '@/stores/typing';

// The typing engine (entry list, expiry timer, derived per-parent /
// per-thread maps) lives in @/stores/typing so hot-path consumers can
// subscribe per-bucket (useTypingFor / useThreadTypingFor) instead of
// re-rendering on every typing event anywhere in the workspace. This
// context remains as the compat surface for writers (ChatPage's WS
// handlers) and whole-map readers.

export { threadTypingKey };

interface TypingContextValue {
  // typingByParent contains only main-list typing (threadRootID==="").
  // ChannelView/ConversationView read from this and remain unaware of
  // thread typing — exactly the segregation the feature requires.
  typingByParent: Record<string, string[]>;
  // typingByThread is keyed by `${parentID}|${threadRootID}` so the
  // ThreadPanel for (ch-1, m-1) only renders typing originating from
  // that thread, not unrelated thread or main-list typing.
  typingByThread: Record<string, string[]>;
  recordTyping: (parentID: string, userID: string, threadRootID?: string) => void;
  clearTyping: (parentID: string, userID: string, threadRootID?: string) => void;
  setSelfUserID: (id: string | null) => void;
}

const TypingContext = createContext<TypingContextValue | null>(null);

export function TypingProvider({ children }: { children: ReactNode }) {
  const typingByParent = useTypingStore((s) => s.typingByParent);
  const typingByThread = useTypingStore((s) => s.typingByThread);

  // The store's expiry interval must not outlive the app shell (tests
  // unmount providers and expect no leaked timers).
  useEffect(() => stopTypingExpiryTimer, []);

  // Memoise the value object so consumers only re-render when state
  // actually changes (the store's rebuild bailout keeps both maps
  // referentially stable across no-op ticks).
  const value = useMemo<TypingContextValue>(
    () => ({ typingByParent, typingByThread, recordTyping, clearTyping, setSelfUserID }),
    [typingByParent, typingByThread],
  );

  return <TypingContext.Provider value={value}>{children}</TypingContext.Provider>;
}

const noopValue: TypingContextValue = {
  typingByParent: {},
  typingByThread: {},
  recordTyping: () => {},
  clearTyping: () => {},
  setSelfUserID: () => {},
};

export function useTyping(): TypingContextValue {
  return useContext(TypingContext) ?? noopValue;
}

// formatTypingPhrase produces the user-visible string for a list of
// typing names. Sane caps:
//   1     → "Alice is typing…"
//   2     → "Alice and Bob are typing…"
//   3     → "Alice, Bob and Cara are typing…"
//   4–5   → "Alice, Bob and 2 others are typing…"
//   6+    → "Lots of people are typing…"
export function formatTypingPhrase(names: string[]): string {
  const n = names.length;
  if (n === 0) return '';
  if (n === 1) return `${names[0]} is typing…`;
  if (n === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (n === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
  if (n <= 5) {
    const others = n - 2;
    return `${names[0]}, ${names[1]} and ${others} others are typing…`;
  }
  return 'Lots of people are typing…';
}
