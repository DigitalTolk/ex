// Persisted, clamped widths for the resizable layout panels (left channel
// sidebar, right side/thread panel). One tiny module owns the storage keys,
// bounds and the reset broadcast so the drag hooks, the panels and the
// profile-settings reset button can never drift apart.

import { readString, removeKey, writeString } from '@/lib/storage';

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
  defaultWidth: 400, // the old maximum: room for long channel names and the Activity tabs
  min: 256, // narrowest that fits the Activity filter tabs with the longest label (Reactions) open
  max: 448,
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

// Every resizable panel. Reset and the "customized" check both walk this one
// list, so a new panel can't be cleared by one and missed by the other.
const PANELS: readonly PanelWidthConfig[] = [SIDEBAR_WIDTH, SIDE_PANEL_WIDTH, MEMBER_LIST_WIDTH, RUN_DRAWER_WIDTH];

// Fired on window whenever the widths are reset (profile settings button),
// so live panels snap back without a reload.
export const PANEL_WIDTHS_RESET_EVENT = 'ex:panel-widths-reset';

export function clampPanelWidth(cfg: PanelWidthConfig, width: number): number {
  if (!Number.isFinite(width)) return cfg.defaultWidth;
  return Math.min(cfg.max, Math.max(cfg.min, Math.round(width)));
}

export function loadPanelWidth(cfg: PanelWidthConfig): number {
  // readString swallows blocked storage (private mode) and returns null.
  const raw = readString(cfg.key);
  if (raw == null) return cfg.defaultWidth;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return cfg.defaultWidth;
  return clampPanelWidth(cfg, parsed);
}

export function savePanelWidth(cfg: PanelWidthConfig, width: number): void {
  // Best-effort: an unsaved width just means the next session uses the default.
  writeString(cfg.key, String(clampPanelWidth(cfg, width)));
}

/** Clears every persisted panel width and notifies live panels. */
export function resetPanelWidths(): void {
  for (const cfg of PANELS) removeKey(cfg.key);
  window.dispatchEvent(new Event(PANEL_WIDTHS_RESET_EVENT));
}

/** True when any panel width differs from its default (drives the reset row). */
export function hasCustomPanelWidths(): boolean {
  return PANELS.some((cfg) => loadPanelWidth(cfg) !== cfg.defaultWidth);
}
