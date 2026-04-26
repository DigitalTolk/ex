import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockUploadAttachment = vi.fn();
const mockDeleteDraftMutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  useDeleteDraftAttachment: () => ({ mutateAsync: mockDeleteDraftMutateAsync, mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageInput } from '@/components/chat/MessageInput';

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('MessageInput - file upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders attach file button', () => {
    render(<MessageInput onSend={vi.fn()} />);
    expect(screen.getByLabelText('Attach file')).toBeInTheDocument();
  });

  it('uploads via uploadAttachment and shows a draft chip; sends attachmentID with the message', async () => {
    mockUploadAttachment.mockResolvedValueOnce({
      id: 'att-1',
      uploadURL: 'http://upload.test/url?sig=abc',
      alreadyExists: false,
      filename: 'myfile.txt',
      contentType: 'text/plain',
      size: 7,
    });

    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['content'], 'myfile.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockUploadAttachment).toHaveBeenCalledWith(file);
    });

    // The draft chip shows the filename
    await waitFor(() => {
      expect(screen.getByText('myfile.txt')).toBeInTheDocument();
    });

    // Sending now includes the attachment ID
    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'see file' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect(onSend).toHaveBeenCalledWith({ body: 'see file', attachmentIDs: ['att-1'] });
  });

  it('shows error when upload fails', async () => {
    mockUploadAttachment.mockRejectedValueOnce(new Error('Network error'));

    render(<MessageInput onSend={vi.fn()} />);

    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['content'], 'x.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Network error');
    });
  });
});
