import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EMOJI_FREQUENCY_CHANGED_EVENT, recordEmojiUse, getFrequentEmojis } from './emoji-frequency';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

describe('emoji-frequency', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  describe('recordEmojiUse', () => {
    it('ignores an empty shortcode without calling the API', async () => {
      await recordEmojiUse('');
      expect(mockApiFetch).not.toHaveBeenCalled();
    });

    it('POSTs the picked shortcode and broadcasts a change event', async () => {
      mockApiFetch.mockResolvedValueOnce(undefined);
      const onChanged = vi.fn();
      window.addEventListener(EMOJI_FREQUENCY_CHANGED_EVENT, onChanged);
      await recordEmojiUse(':tada:');
      window.removeEventListener(EMOJI_FREQUENCY_CHANGED_EVENT, onChanged);
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/emojis/frequent', {
        method: 'POST',
        body: JSON.stringify({ emoji: ':tada:' }),
      });
      // The action bar listens for this to refresh its popular shelf live.
      expect(onChanged).toHaveBeenCalledTimes(1);
    });

    it('swallows API errors and broadcasts no event', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('offline'));
      const onChanged = vi.fn();
      window.addEventListener(EMOJI_FREQUENCY_CHANGED_EVENT, onChanged);
      await expect(recordEmojiUse(':tada:')).resolves.toBeUndefined();
      window.removeEventListener(EMOJI_FREQUENCY_CHANGED_EVENT, onChanged);
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  describe('getFrequentEmojis', () => {
    it('returns an empty list for a non-positive limit without calling the API', async () => {
      expect(await getFrequentEmojis(0)).toEqual([]);
      expect(await getFrequentEmojis(-2)).toEqual([]);
      expect(mockApiFetch).not.toHaveBeenCalled();
    });

    it('fetches and returns the ranked shortcodes', async () => {
      mockApiFetch.mockResolvedValueOnce([':tada:', ':smile:']);
      const out = await getFrequentEmojis(18);
      expect(out).toEqual([':tada:', ':smile:']);
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/emojis/frequent?limit=18');
    });

    it('coerces a non-array response to an empty list', async () => {
      mockApiFetch.mockResolvedValueOnce(undefined);
      expect(await getFrequentEmojis(18)).toEqual([]);
    });

    it('drops non-string entries from the response', async () => {
      mockApiFetch.mockResolvedValueOnce([':a:', 42, null, { name: 'x' }, ':b:']);
      expect(await getFrequentEmojis(18)).toEqual([':a:', ':b:']);
    });

    it('returns an empty list when the request fails', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('boom'));
      expect(await getFrequentEmojis(18)).toEqual([]);
    });
  });
});
