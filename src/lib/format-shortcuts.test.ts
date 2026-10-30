import { describe, expect, it } from 'vitest';
import { formatShortcuts } from './format-shortcuts';

describe('formatShortcuts', () => {
  it('uses ⌘ on Apple platforms, as Slack does', () => {
    const keys = formatShortcuts(true);
    expect(keys.bold).toEqual({ key: 'Mod-b', label: '⌘B', aria: 'Meta+B' });
    expect(keys.strike).toEqual({ key: 'Mod-Shift-x', label: '⌘⇧X', aria: 'Meta+Shift+X' });
    expect(keys.quote.label).toBe('⌘⇧9');
    expect(keys.link.label).toBe('⌘⇧U');
  });

  it('uses Ctrl elsewhere', () => {
    const keys = formatShortcuts(false);
    expect(keys.italic).toEqual({ key: 'Mod-i', label: 'Ctrl I', aria: 'Control+I' });
    expect(keys.code).toEqual({ key: 'Mod-Shift-c', label: 'Ctrl Shift C', aria: 'Control+Shift+C' });
    expect(keys.ol.label).toBe('Ctrl Shift 7');
    expect(keys.ul.label).toBe('Ctrl Shift 8');
  });
});
