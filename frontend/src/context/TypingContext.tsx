import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// EXPIRY_MS is how long an entry survives without a refresh ping. The
// client sends "typing" every 3s while the user is actively composing;
// 6s gives two missed pings of slack before the indicator clears so a
// brief network hiccup doesn't blink the indicator off and back on.
const EXPIRY_MS = 6000;

interface TypingEntry {
  userID: string;
  parentID: string;
  expiresAt: number;
}

interface TypingContextValue {
  typingByParent: Record<string, string[]>;
  recordTyping: (parentID: string, userID: string) => void;
  // clearTyping drops a single (parentID, userID) entry immediately —
  // used by the message.new WS handler so a user stops appearing as
  // "typing" the instant their message lands, without waiting for the
  // expiry to tick.
  clearTyping: (parentID: string, userID: string) => void;
  setSelfUserID: (id: string | null) => void;
}

const TypingContext = createContext<TypingContextValue | null>(null);

// shallowEqualByParent reports whether two typingByParent maps describe
// the same set of {parent → typer-IDs} groupings. Used to bail out of
// setState calls that would otherwise force every consumer to re-render
// every second whether anyone is typing or not.
function shallowEqualByParent(
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

export function TypingProvider({ children }: { children: ReactNode }) {
  const [typingByParent, setTypingByParent] = useState<Record<string, string[]>>({});
  const entriesRef = useRef<TypingEntry[]>([]);
  const selfRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rebuild = useCallback(() => {
    const now = Date.now();
    entriesRef.current = entriesRef.current.filter((e) => e.expiresAt > now);
    const grouped: Record<string, string[]> = {};
    for (const e of entriesRef.current) {
      if (e.userID === selfRef.current) continue;
      const list = grouped[e.parentID] ?? [];
      if (!list.includes(e.userID)) list.push(e.userID);
      grouped[e.parentID] = list;
    }
    setTypingByParent((prev) => (shallowEqualByParent(prev, grouped) ? prev : grouped));
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
    (parentID: string, userID: string) => {
      if (!parentID || !userID) return;
      const idx = entriesRef.current.findIndex(
        (e) => e.parentID === parentID && e.userID === userID,
      );
      const entry: TypingEntry = {
        userID,
        parentID,
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
    (parentID: string, userID: string) => {
      if (!parentID || !userID) return;
      const idx = entriesRef.current.findIndex(
        (e) => e.parentID === parentID && e.userID === userID,
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
  // actually changes (the rebuild() bailout above keeps typingByParent
  // referentially stable across no-op ticks).
  const value = useMemo<TypingContextValue>(
    () => ({ typingByParent, recordTyping, clearTyping, setSelfUserID }),
    [typingByParent, recordTyping, clearTyping, setSelfUserID],
  );

  return <TypingContext.Provider value={value}>{children}</TypingContext.Provider>;
}

const noopValue: TypingContextValue = {
  typingByParent: {},
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
