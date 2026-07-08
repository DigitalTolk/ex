import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchShortcutLabel } from './platform';
import { normalizeHighlightLanguage } from './code-highlight';
import { showToast, TOAST_EVENT, type ToastDetail } from './toast';
import { recordEmojiUse, getFrequentEmojis } from './emoji-frequency';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

// Browser-gate twins for small pure helpers whose remaining arms the
// component suites never reach.

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('platform.searchShortcutLabel', () => {
  it('labels the chord per platform', () => {
    expect(searchShortcutLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('⌘K');
    expect(searchShortcutLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Ctrl K');
  });
});

describe('code-highlight.normalizeHighlightLanguage', () => {
  it('rejects empty and whitespace-only languages, resolves aliases', () => {
    expect(normalizeHighlightLanguage(undefined)).toBeUndefined();
    expect(normalizeHighlightLanguage('   ')).toBeUndefined();
    expect(normalizeHighlightLanguage('TS')).toBe('typescript');
    expect(normalizeHighlightLanguage('zig')).toBe('zig');
  });
});

describe('toast.showToast', () => {
  it('defaults to the error variant (the main callers are failure paths)', () => {
    const heard: ToastDetail[] = [];
    const onToast = (e: Event) => heard.push((e as CustomEvent<ToastDetail>).detail);
    window.addEventListener(TOAST_EVENT, onToast);
    try {
      showToast('boom');
      expect(heard).toEqual([{ message: 'boom', variant: 'error' }]);
    } finally {
      window.removeEventListener(TOAST_EVENT, onToast);
    }
  });
});

describe('emoji-frequency', () => {
  it('recordEmojiUse ignores an empty shortcode without hitting the API', async () => {
    await recordEmojiUse('');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('getFrequentEmojis short-circuits a non-positive limit', async () => {
    expect(await getFrequentEmojis(0)).toEqual([]);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('getFrequentEmojis coerces a non-array payload to an empty shelf', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined as never);
    expect(await getFrequentEmojis(5)).toEqual([]);
  });
});
