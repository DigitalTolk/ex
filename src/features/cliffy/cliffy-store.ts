import { create } from 'zustand';

/** The conversation a Cliffy session was opened from, forwarded to the agent. */
export type CliffyScope = {
  type: 'channel' | 'conversation';
  id: string;
  name?: string;
};

/** Draggable launcher offset from its default bottom-right anchor. */
export type LauncherPos = { x: number; y: number };

// Persist only the two bits that should survive a reload: whether the widget is
// dismissed, and where the user dragged its icon. (Open/scope/seed are session
// state.) localStorage — ex is a Vite SPA, so window is always available; guard
// anyway so tests/SSR can't throw.
const WIDGET_LS_KEY = 'cliffy.widget.v1';
type WidgetPersist = { hidden: boolean; pos: LauncherPos | null };

function loadWidget(): WidgetPersist {
  if (typeof window === 'undefined') return { hidden: false, pos: null };
  try {
    const raw = window.localStorage.getItem(WIDGET_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<WidgetPersist>;
      return { hidden: Boolean(p.hidden), pos: p.pos ?? null };
    }
  } catch {
    /* corrupt/unavailable — fall through to defaults */
  }
  return { hidden: false, pos: null };
}

function saveWidget(p: WidgetPersist): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WIDGET_LS_KEY, JSON.stringify(p));
  } catch {
    /* storage full/blocked — non-fatal */
  }
}

type CliffyState = {
  open: boolean;
  /** One-shot prompt to auto-send when the panel opens (consumed on read). */
  seedPrompt: string | null;
  /** Where the panel was opened from (the current channel/DM). */
  scope: CliffyScope | null;
  /** CliffHub's web origin, from the session probe — turns Cliffy's relative
   * in-app links (/tasks/<id>) into absolute, openable CliffHub links. */
  cliffhubBase: string | null;
  setCliffhubBase: (base: string | null) => void;
  /** Track the chat the user is currently viewing, so the (shared) panel always
   * targets the open channel/DM — even when opened from the floating launcher. */
  setScope: (scope: CliffyScope | null) => void;
  openCliffy: (opts?: { prompt?: string; scope?: CliffyScope | null }) => void;
  /** Read and clear the seed prompt (so it only sends once). */
  consumeSeed: () => string | null;
  close: () => void;
  /** Whole widget dismissed (mascot hidden too). Persisted. */
  hidden: boolean;
  /** Dragged launcher offset, or null for the default anchor. Persisted. */
  launcherPos: LauncherPos | null;
  /** Dismiss the widget entirely (also closes an open panel). */
  hide: () => void;
  /** Bring the dismissed widget back. */
  showWidget: () => void;
  /** Persist a new dragged launcher position. */
  setLauncherPos: (pos: LauncherPos) => void;
};

/**
 * Global Cliffy UI state. Lets a `/cliffy` invocation deep in a conversation
 * composer open the panel (mounted up in the app shell) seeded with the typed
 * prompt and scoped to that conversation — without prop-drilling.
 */
const persistedWidget = loadWidget();

export const useCliffyStore = create<CliffyState>((set, get) => ({
  open: false,
  seedPrompt: null,
  scope: null,
  cliffhubBase: null,
  hidden: persistedWidget.hidden,
  launcherPos: persistedWidget.pos,
  setCliffhubBase: (base) => set({ cliffhubBase: base }),
  setScope: (scope) => set({ scope }),
  openCliffy: (opts) =>
    set({
      // Opening always brings the widget back if it was dismissed.
      hidden: false,
      open: true,
      seedPrompt: opts?.prompt && opts.prompt.trim() !== '' ? opts.prompt.trim() : null,
      scope: opts?.scope ?? get().scope,
    }),
  consumeSeed: () => {
    const seed = get().seedPrompt;
    if (seed !== null) set({ seedPrompt: null });
    return seed;
  },
  close: () => set({ open: false, seedPrompt: null }),
  hide: () => {
    set({ hidden: true, open: false, seedPrompt: null });
    saveWidget({ hidden: true, pos: get().launcherPos });
  },
  showWidget: () => {
    set({ hidden: false });
    saveWidget({ hidden: false, pos: get().launcherPos });
  },
  setLauncherPos: (pos) => {
    set({ launcherPos: pos });
    saveWidget({ hidden: get().hidden, pos });
  },
}));

// `/cliffy` optionally followed by a prompt. Matches the whole trimmed body so
// a message that merely mentions /cliffy mid-sentence is NOT intercepted.
const CLIFFY_COMMAND = /^\/cliffy(?:\s+([\s\S]*))?$/i;

/** True when a composer body is a `/cliffy` invocation (with or without text). */
export function isCliffyCommand(body: string): boolean {
  return CLIFFY_COMMAND.test(body.trim());
}

/** The prompt after `/cliffy` — empty string for a bare `/cliffy`. */
export function cliffyPrompt(body: string): string {
  const match = CLIFFY_COMMAND.exec(body.trim());
  return (match?.[1] ?? '').trim();
}
