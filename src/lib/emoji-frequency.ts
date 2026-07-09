import { apiFetch } from '@/lib/api';

// Per-user "frequently used emoji" tracking, stored server-side in Redis
// (see internal/handler/emoji.go). Both calls are best-effort: a failure
// never blocks emoji selection — the shelf just stays empty.

// Dispatched on `window` after a successful use record so live consumers
// (the message action bar's quick-reaction shelf) can refresh their
// most-used list immediately instead of waiting out the query staleTime.
export const EMOJI_FREQUENCY_CHANGED_EVENT = 'emoji-frequency-changed';

export async function recordEmojiUse(shortcode: string): Promise<void> {
  if (!shortcode) return;
  try {
    await apiFetch('/api/v1/emojis/frequent', {
      method: 'POST',
      body: JSON.stringify({ emoji: shortcode }),
    });
    window.dispatchEvent(new Event(EMOJI_FREQUENCY_CHANGED_EVENT));
  } catch {
    // Recording is non-critical; swallow transient/network errors.
  }
}

export async function getFrequentEmojis(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  try {
    const res = await apiFetch<string[]>(`/api/v1/emojis/frequent?limit=${limit}`);
    // Defensive: only surface string shortcodes so a malformed payload can
    // never reach the renderer (which calls String methods on each entry).
    return Array.isArray(res) ? res.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
