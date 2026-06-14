import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { Attachment } from '@/types';

const batchMock = vi.fn();
vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: (...args: unknown[]) => batchMock(...args),
}));
vi.mock('@/hooks/useAttachmentLightbox', () => ({
  useAttachmentLightbox: () => ({ open: vi.fn(), lightbox: null }),
}));

import { MessageAttachments } from './MessageAttachments';

function makeAttachment(id: string, over: Partial<Attachment> = {}): Attachment {
  return {
    id,
    filename: `${id}.pdf`,
    contentType: 'application/pdf',
    size: 1234,
    url: `https://files.test/${id}`,
    ...over,
  } as Attachment;
}

const baseProps = {
  messageID: 'm1',
  authorName: 'Alice',
  postedAt: '2026-01-01T00:00:00Z',
};

describe('MessageAttachments content-height callback', () => {
  beforeEach(() => batchMock.mockReset());

  it('fires onContentHeightChange once all attachments have resolved', async () => {
    const map = new Map([['a1', makeAttachment('a1')]]);
    batchMock.mockReturnValue({ map, isLoading: false });
    const onContentHeightChange = vi.fn();
    render(<MessageAttachments ids={['a1']} {...baseProps} onContentHeightChange={onContentHeightChange} />);
    await waitFor(() => expect(onContentHeightChange).toHaveBeenCalled());
  });

  it('does not fire while attachments are still loading', () => {
    batchMock.mockReturnValue({ map: new Map(), isLoading: true });
    const onContentHeightChange = vi.fn();
    render(<MessageAttachments ids={['a1']} {...baseProps} onContentHeightChange={onContentHeightChange} />);
    expect(onContentHeightChange).not.toHaveBeenCalled();
  });

  it('does not fire while an id is missing from the resolved map', () => {
    // a1 resolved, a2 still absent → the guard short-circuits.
    const map = new Map([['a1', makeAttachment('a1')]]);
    batchMock.mockReturnValue({ map, isLoading: false });
    const onContentHeightChange = vi.fn();
    render(<MessageAttachments ids={['a1', 'a2']} {...baseProps} onContentHeightChange={onContentHeightChange} />);
    expect(onContentHeightChange).not.toHaveBeenCalled();
  });

  it('renders nothing when there are no ids', () => {
    batchMock.mockReturnValue({ map: new Map(), isLoading: false });
    const { container } = render(<MessageAttachments ids={[]} {...baseProps} />);
    expect(container.firstChild).toBeNull();
  });
});
