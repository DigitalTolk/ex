import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyToClipboard, pastedFiles } from './clipboard';

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

describe('pastedFiles', () => {
  const png = new File(['x'], 'image.png', { type: 'image/png' });
  const pdf = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
  function clip(opts: { files?: File[]; items?: File[]; html?: string; text?: string }): DataTransfer {
    const data: Record<string, string> = { 'text/html': opts.html ?? '', 'text/plain': opts.text ?? '' };
    return {
      files: opts.files ?? [],
      items: (opts.items ?? []).map((f) => ({ kind: 'file', getAsFile: () => f })),
      getData: (t: string) => data[t] ?? '',
    } as unknown as DataTransfer;
  }

  it('attaches a screenshot (an image with no text)', () => {
    expect(pastedFiles(clip({ items: [png] }))).toEqual([png]);
  });

  it('attaches a browser "Copy image" (an image plus <img> HTML, no plain text)', () => {
    expect(pastedFiles(clip({ files: [png], html: '<img src="x">' }))).toEqual([png]);
  });

  it('attaches a copied file that carries its name as plain text but no HTML', () => {
    expect(pastedFiles(clip({ files: [png], text: 'image.png' }))).toEqual([png]);
  });

  it('pastes text copied from Word or Outlook as text, dropping the rendered picture', () => {
    expect(pastedFiles(clip({ files: [png], html: '<p>Hours</p>', text: 'Hours' }))).toEqual([]);
  });

  it('keeps a non-image file even when the clipboard also has text and HTML', () => {
    expect(pastedFiles(clip({ files: [pdf], html: '<p>x</p>', text: 'x' }))).toEqual([pdf]);
  });

  it('treats whitespace-only plain text as no text', () => {
    expect(pastedFiles(clip({ files: [png], html: '<img src="x">', text: ' \n' }))).toEqual([png]);
  });

  it('skips clipboard items that are not files or do not resolve to one', () => {
    const dt = {
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => null },
        { kind: 'file', getAsFile: () => png },
      ],
      getData: () => '',
    } as unknown as DataTransfer;
    expect(pastedFiles(dt)).toEqual([png]);
  });

  it('returns nothing for a text-only paste', () => {
    expect(pastedFiles(clip({ text: 'hello' }))).toEqual([]);
  });
});
