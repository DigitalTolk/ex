import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './clipboard';

// Browser coverage for the REAL copyToClipboard (every component test mocks
// @/lib/clipboard, so nothing else in the browser suite loads this module).
// Two paths: the async Clipboard API happy path, and the hidden-textarea +
// execCommand fallback when writeText throws (permission denied / insecure
// context / older browsers).

describe('copyToClipboard (real, browser)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes through navigator.clipboard.writeText and skips the fallback', async () => {
    // Stub writeText to resolve so the happy path is deterministic across the
    // chromium/webkit projects regardless of clipboard-write permission state.
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
    await copyToClipboard('hello clipboard');
    expect(writeText).toHaveBeenCalledWith('hello clipboard');
    // The fallback textarea is never created on the happy path.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to a hidden textarea + execCommand when writeText throws, and cleans up', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const exec = vi.spyOn(document, 'execCommand');
    await copyToClipboard('fallback text');
    // The fallback selected the value and issued the legacy copy command.
    expect(exec).toHaveBeenCalledWith('copy');
    // The scratch textarea is removed again — best-effort with no DOM residue.
    expect(document.querySelector('textarea')).toBeNull();
  });
});
