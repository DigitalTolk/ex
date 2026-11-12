import { describe, it, expect } from 'vitest';
import { isApplePlatform, numberedShortcut, numberedShortcutLabel, searchShortcutLabel } from './platform';

describe('platform helpers', () => {
  it('isApplePlatform detects macOS / iOS / iPadOS user-agents', () => {
    expect(isApplePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
    expect(isApplePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(true);
    expect(isApplePlatform('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe(true);
    expect(isApplePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isApplePlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
    expect(isApplePlatform('')).toBe(false);
  });

  it('searchShortcutLabel shows ⌘K on Apple and Ctrl K elsewhere', () => {
    expect(searchShortcutLabel('Macintosh; Intel Mac OS X')).toBe('⌘K');
    expect(searchShortcutLabel('Windows NT 10.0')).toBe('Ctrl K');
    expect(searchShortcutLabel('X11; Linux x86_64')).toBe('Ctrl K');
  });

  it('numberedShortcutLabel shows ⌘1 on Apple and Ctrl 1 elsewhere', () => {
    expect(numberedShortcutLabel(1, 'Macintosh; Intel Mac OS X')).toBe('⌘1');
    expect(numberedShortcutLabel(9, 'Windows NT 10.0')).toBe('Ctrl 9');
  });

  it('numberedShortcut reads the platform chord plus 1 to 9, nothing else', () => {
    const mac = 'Macintosh; Intel Mac OS X';
    const win = 'Windows NT 10.0';
    const ev = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...mods,
    });
    expect(numberedShortcut(ev('1', { metaKey: true }), mac)).toBe(1);
    expect(numberedShortcut(ev('9', { ctrlKey: true }), win)).toBe(9);
    // The other platform's modifier, both at once, Shift or Alt: not ours.
    expect(numberedShortcut(ev('1', { ctrlKey: true }), mac)).toBeNull();
    expect(numberedShortcut(ev('1', { metaKey: true }), win)).toBeNull();
    expect(numberedShortcut(ev('1', { metaKey: true, ctrlKey: true }), mac)).toBeNull();
    expect(numberedShortcut(ev('1', { metaKey: true, shiftKey: true }), mac)).toBeNull();
    expect(numberedShortcut(ev('1', { metaKey: true, altKey: true }), mac)).toBeNull();
    // Not a digit 1 to 9.
    expect(numberedShortcut(ev('0', { metaKey: true }), mac)).toBeNull();
    expect(numberedShortcut(ev('k', { metaKey: true }), mac)).toBeNull();
    expect(numberedShortcut(ev('1'), mac)).toBeNull();
  });
});
