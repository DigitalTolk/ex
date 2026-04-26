import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Attachment } from '@/types';

const useAttachmentsBatchMock = vi.fn();
vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: (ids: string[]) => useAttachmentsBatchMock(ids),
}));

import { MessageAttachments } from '@/components/chat/MessageAttachments';

beforeEach(() => {
  useAttachmentsBatchMock.mockReset();
});

describe('MessageAttachments', () => {
  it('returns null when ids list is empty (renders nothing)', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
    const { container } = render(<MessageAttachments ids={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an image attachment as a link with <img>', () => {
    const att: Attachment = {
      id: 'a-1',
      filename: 'cat.png',
      contentType: 'image/png',
      size: 12345,
      url: 'https://cdn/cat.png',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-1', att]]),
      isLoading: false,
    });
    render(<MessageAttachments ids={['a-1']} />);
    const link = screen.getByLabelText('Open image cat.png') as HTMLAnchorElement;
    expect(link.href).toContain('cat.png');
    expect(screen.getByAltText('cat.png')).toBeInTheDocument();
  });

  it('renders a non-image as a download link with size + filename', () => {
    const att: Attachment = {
      id: 'a-2',
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      size: 4_500_000,
      url: 'https://cdn/doc.pdf',
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-2', att]]),
      isLoading: false,
    });
    render(<MessageAttachments ids={['a-2']} />);
    expect(screen.getByLabelText('Download doc.pdf')).toBeInTheDocument();
    expect(screen.getByText('doc.pdf')).toBeInTheDocument();
    // formatBytes uses MB when size >= 1MB
    expect(screen.getByText(/MB/)).toBeInTheDocument();
  });

  it('shows a "Loading…" skeleton while the batch is in flight', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: true });
    render(<MessageAttachments ids={['a-3']} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows the "Attachment unavailable" skeleton when the batch has resolved without the id', () => {
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
    render(<MessageAttachments ids={['a-missing']} />);
    expect(screen.getByText('Attachment unavailable')).toBeInTheDocument();
  });

  it('falls back to a plain link when the image content type lacks a URL', () => {
    // Edge case: image attachment with no presigned URL — render as the
    // generic file row instead of a broken <img>.
    const att: Attachment = {
      id: 'a-4',
      filename: 'noimg.png',
      contentType: 'image/png',
      size: 100,
      // no url
    };
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([['a-4', att]]),
      isLoading: false,
    });
    render(<MessageAttachments ids={['a-4']} />);
    expect(screen.getByLabelText('Download noimg.png')).toBeInTheDocument();
  });
});
