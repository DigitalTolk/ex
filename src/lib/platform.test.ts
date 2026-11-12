import { describe, it, expect } from 'vitest';
import { isApplePlatform, searchShortcutLabel } from './platform';

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
});
