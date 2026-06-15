import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordEmojiUse, getFrequentEmojis } from './emoji-frequency';
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

    it('POSTs the picked shortcode', async () => {
      mockApiFetch.mockResolvedValueOnce(undefined);
      await recordEmojiUse(':tada:');
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/emojis/frequent', {
        method: 'POST',
        body: JSON.stringify({ emoji: ':tada:' }),
      });
    });

    it('swallows API errors', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('offline'));
      await expect(recordEmojiUse(':tada:')).resolves.toBeUndefined();
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
