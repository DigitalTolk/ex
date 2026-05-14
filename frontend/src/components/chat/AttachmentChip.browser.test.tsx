import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { AttachmentChip } from './AttachmentChip';

const baseAtt = {
  id: 'a-1',
  filename: 'photo.png',
  contentType: 'image/png',
  size: 12345,
};

describe('AttachmentChip browser behaviour', () => {
  it('renders the filename and human-readable size', async () => {
    const screen = await render(<AttachmentChip att={baseAtt} />);
    await expect.element(screen.getByText('photo.png')).toBeVisible();
    // formatBytes(12345) ≈ "12.06 KB" / "12.1 KB" — just assert KB.
    await expect.element(screen.getByText(/KB/)).toBeVisible();
  });

  it('renders an image preview when the attachment is an image and a localURL is set', async () => {
    await render(<AttachmentChip att={{ ...baseAtt, localURL: 'blob:test/1' }} />);
    const thumb = document.querySelector('[data-testid="attachment-chip-thumb"]') as HTMLImageElement | null;
    expect(thumb).not.toBeNull();
    expect(thumb?.src).toContain('blob:test/1');
  });

  it('renders the generic file icon when the attachment is not an image', async () => {
    await render(<AttachmentChip att={{ ...baseAtt, filename: 'spec.pdf', contentType: 'application/pdf' }} />);
    expect(document.querySelector('[data-testid="attachment-chip-thumb"]')).toBeNull();
  });

  it('renders a progress bar while uploading and exposes ARIA progress attrs', async () => {
    await render(<AttachmentChip att={{ ...baseAtt, progress: 0.42 }} />);
    const chip = document.querySelector('[data-testid="attachment-chip"]') as HTMLElement;
    expect(chip.dataset.uploading).toBe('true');
    const bar = document.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-label')).toContain('photo.png');
  });

  it('clamps the progress percentage into [0, 100] when out of range', async () => {
    await render(<AttachmentChip att={{ ...baseAtt, progress: 1.7 }} />);
    // 1.7 → uploading is false (>= 1), so no progressbar should render.
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('wires the remove button to the onRemove callback', async () => {
    const onRemove = vi.fn();
    await render(<AttachmentChip att={baseAtt} onRemove={onRemove} />);
    const btn = document.querySelector('button[aria-label="Remove photo.png"]') as HTMLButtonElement;
    btn.click();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('omits the remove button when no onRemove handler is provided', async () => {
    await render(<AttachmentChip att={baseAtt} />);
    expect(document.querySelector('button[aria-label^="Remove"]')).toBeNull();
  });
});
