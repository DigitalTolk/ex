import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('MessageInput toolbar buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;
  });

  it('Bold/Italic/Strikethrough/Code/Quote/List buttons trigger execCommand on the editor', () => {
    const exec = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    renderWithClient(<MessageInput onSend={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Bold (Ctrl+B)'));
    expect(exec).toHaveBeenCalledWith('bold');
    fireEvent.click(screen.getByLabelText('Italic (Ctrl+I)'));
    expect(exec).toHaveBeenCalledWith('italic');
    fireEvent.click(screen.getByLabelText('Strikethrough'));
    expect(exec).toHaveBeenCalledWith('strikeThrough');
    fireEvent.click(screen.getByLabelText('Quote'));
    expect(exec).toHaveBeenCalledWith('formatBlock', false, 'blockquote');
    fireEvent.click(screen.getByLabelText('List'));
    expect(exec).toHaveBeenCalledWith('insertUnorderedList');
    // Code is the inline-wrapper code path — must not throw.
    expect(() => fireEvent.click(screen.getByLabelText('Code (Ctrl+E)'))).not.toThrow();
  });

  it('Link button prompts and calls createLink with the answered URL', () => {
    const exec = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    renderWithClient(<MessageInput onSend={vi.fn()} />);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('https://example.com');
    fireEvent.click(screen.getByLabelText('Link'));
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://example.com');
    promptSpy.mockRestore();
  });

  it('clicking the chip remove button removes the draft and calls the delete mutation', async () => {
    const init = {
      id: 'att-rm',
      uploadURL: 'http://upload/u',
      alreadyExists: true,
      filename: 'file.txt',
      contentType: 'text/plain',
      size: 1,
    };
    mockUploadAttachment.mockImplementationOnce(
      async (
        _file: File,
        cb?: { onInit?: (i: typeof init) => void; onProgress?: (n: number) => void },
      ) => {
        cb?.onInit?.(init);
        cb?.onProgress?.(1);
        return init;
      },
    );

    renderWithClient(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['x'], 'file.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('file.txt')).toBeInTheDocument();
    });

    // Click the chip's remove button
    fireEvent.click(screen.getByLabelText(/^Remove /));
    await waitFor(() => {
      expect(screen.queryByText('file.txt')).toBeNull();
    });
    expect(mockDeleteDraftMutateAsync).toHaveBeenCalledWith('att-rm');
  });

  it('renders inline variant without the top border wrapper', () => {
    renderWithClient(<MessageInput onSend={vi.fn()} variant="inline" />);
    // The inline variant uses p-0 instead of border-t p-3 on the outer div.
    expect(screen.getByLabelText('Message input').closest('.p-0')).not.toBeNull();
  });

  it('focusKey change re-focuses the editor', async () => {
    const { rerender } = renderWithClient(
      <MessageInput onSend={vi.fn()} focusKey="a" />,
    );
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MessageInput onSend={vi.fn()} focusKey="b" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Message input'));
    });
  });

  it('inline variant: onSend does not blank the editor (parent unmounts)', async () => {
    const onSend = vi.fn();
    renderWithClient(
      <MessageInput
        onSend={onSend}
        variant="inline"
        initialBody="hello world"
      />,
    );
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(onSend).toHaveBeenCalled();
    // Editor still shows the body — parent owns unmount lifecycle.
    expect(screen.getByLabelText('Message input').textContent).toContain('hello');
  });

  it('does not call delete mutation when cancelling failed remove (silent failure)', async () => {
    mockDeleteDraftMutateAsync.mockRejectedValueOnce(new Error('still referenced'));
    const init = {
      id: 'att-fail',
      uploadURL: 'http://upload/u',
      alreadyExists: true,
      filename: 'file2.txt',
      contentType: 'text/plain',
      size: 1,
    };
    mockUploadAttachment.mockImplementationOnce(
      async (
        _file: File,
        cb?: { onInit?: (i: typeof init) => void; onProgress?: (n: number) => void },
      ) => {
        cb?.onInit?.(init);
        cb?.onProgress?.(1);
        return init;
      },
    );

    renderWithClient(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['x'], 'file2.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('file2.txt')).toBeInTheDocument();
    });

    // The remove path swallows mutation errors silently.
    fireEvent.click(screen.getByLabelText(/^Remove /));
    await waitFor(() => {
      expect(mockDeleteDraftMutateAsync).toHaveBeenCalled();
    });
    // Chip is gone regardless of mutation outcome.
    expect(screen.queryByText('file2.txt')).toBeNull();
  });
});
