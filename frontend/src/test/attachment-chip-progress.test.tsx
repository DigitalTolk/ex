import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttachmentChip, type DraftAttachment } from '@/components/chat/AttachmentChip';

function makeDraft(overrides: Partial<DraftAttachment> = {}): DraftAttachment {
  return {
    id: 'a-1',
    filename: 'file.png',
    contentType: 'image/png',
    size: 1024,
    ...overrides,
  };
}

describe('AttachmentChip — upload progress', () => {
  it('renders a progressbar while progress < 1', () => {
    render(<AttachmentChip att={makeDraft({ progress: 0.42 })} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('hides the progressbar when progress is undefined (no upload in flight)', () => {
    render(<AttachmentChip att={makeDraft()} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('hides the progressbar at 100%', () => {
    render(<AttachmentChip att={makeDraft({ progress: 1 })} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('renders an image preview when mobile upload metadata falls back to an image filename', () => {
    render(
      <AttachmentChip
        att={makeDraft({
          filename: 'camera-photo.jpg',
          contentType: 'application/octet-stream',
          url: 'https://cdn.example.test/camera-photo.jpg',
        })}
      />,
    );

    expect(screen.getByTestId('attachment-chip-thumb')).toHaveAttribute(
      'src',
      'https://cdn.example.test/camera-photo.jpg',
    );
  });
});
