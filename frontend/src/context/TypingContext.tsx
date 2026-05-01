import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// EXPIRY_MS is how long an entry survives without a refresh ping. The
// client sends "typing" every 3s while the user is actively composing;
// 6s gives two missed pings of slack before the indicator clears so a
// brief network hiccup doesn't blink the indicator off and back on.
const EXPIRY_MS = 6000;

interface TypingEntry {
  userID: string;
  parentID: string;
  // Empty string = main MessageList typing. Non-empty = typing inside a
  // ThreadPanel rooted at that message ID. Stored together in the same
  // entries list because expiry semantics are identical and the (parent,
  // threadRoot) tuple is what segregates the two surfaces in the UI.
  threadRootID: string;
  expiresAt: number;
}

interface TypingContextValue {
  // typingByParent contains only main-list typing (threadRootID==="").
  // ChannelView/ConversationView read from this and remain unaware of
  // thread typing — exactly the segregation the feature requires.
  typingByParent: Record<string, string[]>;
  // typingByThread is keyed by `${parentID}|${threadRootID}` so the
  // ThreadPanel for (ch-1, m-1) only renders typing originating from
  // that thread, not unrelated thread or main-list typing.
  typingByThread: Record<string, string[]>;
  // recordTyping accepts an optional threadRootID so a thread-scoped
  // typing event lands in its own bucket. Existing call sites that
  // pass two args continue to work (threadRootID defaults to "").
  recordTyping: (parentID: string, userID: string, threadRootID?: string) => void;
  // clearTyping drops a (parentID, userID, threadRootID) entry
  // immediately — used by the message.new WS handler so a user stops
  // appearing as "typing" the instant their message lands. The
  // threadRootID lookup uses the same default ("") for main-list
  // messages and the parentMessageID for thread replies.
  clearTyping: (parentID: string, userID: string, threadRootID?: string) => void;
  setSelfUserID: (id: string | null) => void;
}

const TypingContext = createContext<TypingContextValue | null>(null);

// shallowEqualByKey reports whether two `key → user-list` maps describe
// the same set of typers per bucket. Used to bail out of setState calls
// that would otherwise force every consumer to re-render every second
// whether anyone is typing or not.
function shallowEqualByKey(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (!bv || av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
  }
  return true;
}

// threadKey is the composition used to key typingByThread. Kept as a
// function so future test helpers / readers don't have to remember the
// pipe-delimited convention.
export function threadTypingKey(parentID: string, threadRootID: string): string {
  return `${parentID}|${threadRootID}`;
}

export function TypingProvider({ children }: { children: ReactNode }) {
  const [typingByParent, setTypingByParent] = useState<Record<string, string[]>>({});
  const [typingByThread, setTypingByThread] = useState<Record<string, string[]>>({});
  const entriesRef = useRef<TypingEntry[]>([]);
  const selfRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rebuild = useCallback(() => {
    const now = Date.now();
    entriesRef.current = entriesRef.current.filter((e) => e.expiresAt > now);
    const groupedParent: Record<string, string[]> = {};
    const groupedThread: Record<string, string[]> = {};
    for (const e of entriesRef.current) {
      if (e.userID === selfRef.current) continue;
      if (e.threadRootID === '') {
        const list = groupedParent[e.parentID] ?? [];
        if (!list.includes(e.userID)) list.push(e.userID);
        groupedParent[e.parentID] = list;
      } else {
        const k = threadTypingKey(e.parentID, e.threadRootID);
        const list = groupedThread[k] ?? [];
        if (!list.includes(e.userID)) list.push(e.userID);
        groupedThread[k] = list;
      }
    }
    setTypingByParent((prev) => (shallowEqualByKey(prev, groupedParent) ? prev : groupedParent));
    setTypingByThread((prev) => (shallowEqualByKey(prev, groupedThread) ? prev : groupedThread));
  }, []);

  // Run the expiry tick only while someone is actively typing — most of
  // the time the entries list is empty and a 1Hz interval would cause a
  // pointless wakeup forever.
  const ensureTimer = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      rebuild();
      if (entriesRef.current.length === 0 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, 1000);
  }, [rebuild]);

  const recordTyping = useCallback(
    (parentID: string, userID: string, threadRootID: string = '') => {
      if (!parentID || !userID) return;
      const idx = entriesRef.current.findIndex(
        (e) =>
          e.parentID === parentID &&
          e.userID === userID &&
          e.threadRootID === threadRootID,
      );
      const entry: TypingEntry = {
        userID,
        parentID,
        threadRootID,
        expiresAt: Date.now() + EXPIRY_MS,
      };
      if (idx >= 0) {
        entriesRef.current[idx] = entry;
      } else {
        entriesRef.current.push(entry);
      }
      ensureTimer();
      rebuild();
    },
    [ensureTimer, rebuild],
  );

  const setSelfUserID = useCallback(
    (id: string | null) => {
      selfRef.current = id;
      rebuild();
    },
    [rebuild],
  );

  const clearTyping = useCallback(
    (parentID: string, userID: string, threadRootID: string = '') => {
      if (!parentID || !userID) return;
      const idx = entriesRef.current.findIndex(
        (e) =>
          e.parentID === parentID &&
          e.userID === userID &&
          e.threadRootID === threadRootID,
      );
      if (idx < 0) return;
      entriesRef.current.splice(idx, 1);
      rebuild();
    },
    [rebuild],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Memoise the value object so consumers only re-render when state
  // actually changes (the rebuild() bailout above keeps both maps
  // referentially stable across no-op ticks).
  const value = useMemo<TypingContextValue>(
    () => ({ typingByParent, typingByThread, recordTyping, clearTyping, setSelfUserID }),
    [typingByParent, typingByThread, recordTyping, clearTyping, setSelfUserID],
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
