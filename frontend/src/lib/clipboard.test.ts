import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyToClipboard } from './clipboard';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyToClipboard', () => {
  it('uses the async Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyToClipboard('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
    vi.unstubAllGlobals();
  });

  it('falls back to a hidden textarea + execCommand when the async API throws', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    await copyToClipboard('fallback text');
    expect(exec).toHaveBeenCalledWith('copy');
    // The temporary textarea is removed after the copy.
    expect(document.querySelector('textarea')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('swallows an execCommand failure in the fallback path', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => {
      throw new Error('not supported');
    });
    await expect(copyToClipboard('x')).resolves.toBeUndefined();
    expect(document.querySelector('textarea')).toBeNull();
    vi.unstubAllGlobals();
  });
});
