import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
    const init = {
      id: 'att-1',
      uploadURL: 'http://upload.test/url?sig=abc',
      alreadyExists: false,
      filename: 'myfile.txt',
      contentType: 'text/plain',
      size: 7,
    };
    // The new uploadAttachment signature takes a callbacks bag — fire
    // onInit + a final onProgress(1) the way the real impl does.
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

    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['content'], 'myfile.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockUploadAttachment).toHaveBeenCalled();
      expect(mockUploadAttachment.mock.calls[0][0]).toBe(file);
    });

    // The draft chip shows the filename
    await waitFor(() => {
      expect(screen.getByText('myfile.txt')).toBeInTheDocument();
    });

    // Sending now includes the attachment ID. The composer is a
    // contentEditable WYSIWYG, so we set textContent + fire the input
    // event the editor listens to.
    const editor = screen.getByLabelText('Message input');
    editor.textContent = 'see file';
    fireEvent.input(editor);
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

  it('uploads files pasted from the clipboard as attachments', async () => {
    const init = {
      id: 'att-paste-1',
      uploadURL: 'http://upload.test/x',
      alreadyExists: false,
      filename: 'screenshot.png',
      contentType: 'image/png',
      size: 1234,
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

    render(<MessageInput onSend={vi.fn()} />);
    const editor = screen.getByLabelText('Message input');
    const pasted = new File(['png-bytes'], 'screenshot.png', { type: 'image/png' });

    // Construct a paste event whose clipboardData.items reports a file —
    // that's the path browsers use for clipboard images and copied files.
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => pasted,
          },
        ],
      },
    });
    await act(async () => { editor.dispatchEvent(event); });

    await waitFor(() => {
      expect(mockUploadAttachment).toHaveBeenCalled();
      expect(mockUploadAttachment.mock.calls[0][0]).toBe(pasted);
    });
    await waitFor(() => {
      expect(screen.getByText('screenshot.png')).toBeInTheDocument();
    });
  });

  it('ignores text-only paste events (does not call uploadAttachment)', () => {
    render(<MessageInput onSend={vi.fn()} />);
    const editor = screen.getByLabelText('Message input');

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
    });
    editor.dispatchEvent(event);

    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });
});
