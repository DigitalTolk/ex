import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockUploadAttachment = vi.fn();
const mockDeleteDraftMutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  useDeleteDraftAttachment: () => ({ mutateAsync: mockDeleteDraftMutateAsync, mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageInput } from './MessageInput';

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageInput - file upload', () => {
  it('clicking the attach button triggers the hidden file input', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={vi.fn()} />);

    const attach = screen.getByLabelText('Attach file');
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');

    await user.click(attach);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('shows a draft chip after a successful upload', async () => {
    mockUploadAttachment.mockResolvedValueOnce({
      id: 'att-99',
      uploadURL: 'http://s3/u',
      alreadyExists: false,
      filename: 'pic.png',
      contentType: 'image/png',
      size: 1,
    });

    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(screen.getByText('pic.png')).toBeInTheDocument();
    });
  });

  it('shows upload error when upload throws (e.g. PUT failure)', async () => {
    mockUploadAttachment.mockRejectedValueOnce(new Error('Upload failed: 502'));

    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Upload failed: 502/i);
  });

  it('shows error when presign API fails', async () => {
    mockUploadAttachment.mockRejectedValueOnce(new Error('presign failed'));

    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    expect(await screen.findByRole('alert')).toHaveTextContent('presign failed');
  });

  it('does nothing when no file is chosen', () => {
    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { value: [], configurable: true });
    fireEvent.change(fileInput);
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });
});
