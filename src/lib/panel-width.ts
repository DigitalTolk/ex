// Persisted, clamped widths for the resizable layout panels (left channel
// sidebar, right side/thread panel). One tiny module owns the storage keys,
// bounds and the reset broadcast so the drag hooks, the panels and the
// profile-settings reset button can never drift apart.

export interface PanelWidthConfig {
  /** localStorage key holding the persisted width (px). */
  key: string;
  defaultWidth: number;
  min: number;
  max: number;
}

// Bounds are deliberate: the sidebar must never shrink below what a channel
// row with badge needs, nor grow past what leaves the chat column readable;
// the right panel mirrors the thread composer's comfortable minimum.
export const SIDEBAR_WIDTH: PanelWidthConfig = {
  key: 'ex.layout.sidebarWidth',
  defaultWidth: 288, // Tailwind w-72 — the historical fixed width
  min: 208,
  max: 400,
};

export const SIDE_PANEL_WIDTH: PanelWidthConfig = {
  key: 'ex.layout.sidePanelWidth',
  defaultWidth: 448, // Tailwind w-[28rem] — the historical fixed width
  min: 320,
  max: 600,
};

// The channel members rail is narrower than the content panels: rows are a
// single avatar+name line, so it tolerates a smaller minimum.
export const MEMBER_LIST_WIDTH: PanelWidthConfig = {
  key: 'ex.layout.memberListWidth',
  defaultWidth: 320, // Tailwind w-80 — the historical fixed width
  min: 256,
  max: 480,
};

// The run-activity drawer carries dense timeline rows (API calls, grep
// commands, clipped results) — it defaults wider than the thread panel and
// may grow to most of the viewport for reading raw responses.
export const RUN_DRAWER_WIDTH: PanelWidthConfig = {
  key: 'ex.layout.runDrawerWidth',
  defaultWidth: 560,
  min: 384, // the historical fixed max-w-sm
  max: 1024,
};

// Fired on window whenever the widths are reset (profile settings button),
// so live panels snap back without a reload.
export const PANEL_WIDTHS_RESET_EVENT = 'ex:panel-widths-reset';

export function clampPanelWidth(cfg: PanelWidthConfig, width: number): number {
  if (!Number.isFinite(width)) return cfg.defaultWidth;
  return Math.min(cfg.max, Math.max(cfg.min, Math.round(width)));
}

export function loadPanelWidth(cfg: PanelWidthConfig): number {
  try {
    const raw = window.localStorage.getItem(cfg.key);
    if (raw == null) return cfg.defaultWidth;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return cfg.defaultWidth;
    return clampPanelWidth(cfg, parsed);
  } catch {
    // Storage unavailable (private mode restrictions) — fall back silently.
    return cfg.defaultWidth;
  }
}

export function savePanelWidth(cfg: PanelWidthConfig, width: number): void {
  try {
    window.localStorage.setItem(cfg.key, String(clampPanelWidth(cfg, width)));
  } catch {
    // Best-effort: an unsaved width just means the next session uses the default.
  }
}

/** Clears every persisted panel width and notifies live panels. */
export function resetPanelWidths(): void {
  try {
    window.localStorage.removeItem(SIDEBAR_WIDTH.key);
    window.localStorage.removeItem(SIDE_PANEL_WIDTH.key);
    window.localStorage.removeItem(MEMBER_LIST_WIDTH.key);
    window.localStorage.removeItem(RUN_DRAWER_WIDTH.key);
  } catch {
    // Nothing stored anywhere reachable — the event alone resets live state.
  }
  window.dispatchEvent(new Event(PANEL_WIDTHS_RESET_EVENT));
}

/** True when any panel width differs from its default (drives the reset row). */
export function hasCustomPanelWidths(): boolean {
  return (
    loadPanelWidth(SIDEBAR_WIDTH) !== SIDEBAR_WIDTH.defaultWidth ||
    loadPanelWidth(SIDE_PANEL_WIDTH) !== SIDE_PANEL_WIDTH.defaultWidth ||
    loadPanelWidth(MEMBER_LIST_WIDTH) !== MEMBER_LIST_WIDTH.defaultWidth
  );
}
