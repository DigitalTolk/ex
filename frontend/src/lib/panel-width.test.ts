import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PANEL_WIDTHS_RESET_EVENT,
  SIDEBAR_WIDTH,
  SIDE_PANEL_WIDTH,
  clampPanelWidth,
  hasCustomPanelWidths,
  loadPanelWidth,
  resetPanelWidths,
  savePanelWidth,
} from './panel-width';

describe('panel-width', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('clamps into the configured bounds and rounds fractional widths', () => {
    expect(clampPanelWidth(SIDEBAR_WIDTH, 100)).toBe(SIDEBAR_WIDTH.min);
    expect(clampPanelWidth(SIDEBAR_WIDTH, 10_000)).toBe(SIDEBAR_WIDTH.max);
    expect(clampPanelWidth(SIDEBAR_WIDTH, 300.6)).toBe(301);
    expect(clampPanelWidth(SIDEBAR_WIDTH, Number.NaN)).toBe(SIDEBAR_WIDTH.defaultWidth);
  });

  it('load returns the default when nothing is stored or the value is garbage', () => {
    expect(loadPanelWidth(SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.defaultWidth);
    localStorage.setItem(SIDEBAR_WIDTH.key, 'not-a-number');
    expect(loadPanelWidth(SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.defaultWidth);
  });

  it('save/load round-trips a clamped width', () => {
    savePanelWidth(SIDEBAR_WIDTH, 999_999);
    expect(loadPanelWidth(SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.max);
    savePanelWidth(SIDE_PANEL_WIDTH, 500);
    expect(loadPanelWidth(SIDE_PANEL_WIDTH)).toBe(500);
  });

  it('load clamps a stale out-of-bounds stored value', () => {
    localStorage.setItem(SIDEBAR_WIDTH.key, '5');
    expect(loadPanelWidth(SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.min);
  });

  it('reset clears both keys and broadcasts the reset event', () => {
    savePanelWidth(SIDEBAR_WIDTH, 350);
    savePanelWidth(SIDE_PANEL_WIDTH, 500);
    const heard = vi.fn();
    window.addEventListener(PANEL_WIDTHS_RESET_EVENT, heard);
    resetPanelWidths();
    window.removeEventListener(PANEL_WIDTHS_RESET_EVENT, heard);
    expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBeNull();
    expect(localStorage.getItem(SIDE_PANEL_WIDTH.key)).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('hasCustomPanelWidths reflects any deviation from defaults', () => {
    expect(hasCustomPanelWidths()).toBe(false);
    savePanelWidth(SIDEBAR_WIDTH, 350);
    expect(hasCustomPanelWidths()).toBe(true);
    resetPanelWidths();
    expect(hasCustomPanelWidths()).toBe(false);
    savePanelWidth(SIDE_PANEL_WIDTH, 500);
    expect(hasCustomPanelWidths()).toBe(true);
  });

  it('storage failures degrade to defaults instead of throwing', () => {
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(loadPanelWidth(SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.defaultWidth);
      expect(() => savePanelWidth(SIDEBAR_WIDTH, 300)).not.toThrow();
      expect(() => resetPanelWidths()).not.toThrow();
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});
