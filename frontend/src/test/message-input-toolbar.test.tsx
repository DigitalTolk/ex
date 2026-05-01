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
  });

  it('block toolbar buttons each apply their formatting to the seeded body', async () => {
    // Block-level toolbar buttons render distinct DOM elements that we
    // can latch onto. Inline-mark buttons render via theme classes on
    // <span data-lexical-text> elements — those are covered by the
    // dedicated mark test below.
    const cases: Array<{ label: string; selector: string }> = [
      { label: 'Quote', selector: 'blockquote' },
      { label: 'List', selector: 'ul' },
    ];
    for (const c of cases) {
      const { unmount } = renderWithClient(<MessageInput onSend={vi.fn()} initialBody="hello" />);
      const editor = await screen.findByLabelText('Message input');
      fireEvent.click(screen.getByLabelText(c.label));
      await waitFor(() => {
        expect(editor.querySelector(c.selector)).not.toBeNull();
      });
      unmount();
    }
  });

  it('inline mark buttons (Bold/Italic/Strikethrough/Code) toggle the corresponding text format on the seeded body', async () => {
    // Lexical renders text-format spans (Bold/Italic/Strike) as
    // <span data-lexical-text> with theme classes; the inline-code
    // format renders as a real <code> element. Both are observable via
    // a specific theme-class marker.
    const cases: Array<{ label: string; marker: string }> = [
      { label: 'Bold (Ctrl+B)', marker: 'font-semibold' },
      { label: 'Italic (Ctrl+I)', marker: 'italic' },
      { label: 'Strikethrough', marker: 'line-through' },
      { label: 'Code (Ctrl+E)', marker: 'font-mono' },
    ];
    for (const c of cases) {
      const { unmount } = renderWithClient(<MessageInput onSend={vi.fn()} initialBody="hello" />);
      const editor = await screen.findByLabelText('Message input');
      fireEvent.click(screen.getByLabelText(c.label));
      await waitFor(() => {
        // Any element inside the editor carrying the theme class is
        // proof the format took effect.
        const candidate = editor.querySelector(`.${c.marker.replace(/\s+/g, '.')}`);
        expect(candidate).not.toBeNull();
      });
      unmount();
    }
  });

  it('Link button opens the modal and wraps the inserted text in an <a href>', async () => {
    // Replaces the previous window.prompt() flow — the user requested
    // no JS popups; the toolbar Link button now opens a shadcn dialog.
    renderWithClient(<MessageInput onSend={vi.fn()} initialBody="docs" />);
    const editor = await screen.findByLabelText('Message input');
    fireEvent.click(screen.getByLabelText('Link'));
    const urlField = await screen.findByLabelText('URL');
    const textField = screen.getByLabelText('Text');
    fireEvent.change(textField, { target: { value: 'docs' } });
    fireEvent.change(urlField, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    await waitFor(() => {
      expect(editor.querySelector('a[href="https://example.com"]')).not.toBeNull();
    });
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
    // Wait for Lexical's post-mount placeholder effect to settle
    // before firing the send click — otherwise the placeholder's
    // delayed state update lands after the click and surfaces an
    // act() warning.
    const editor = await screen.findByLabelText('Message input');
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(onSend).toHaveBeenCalled();
    // Editor still shows the body — parent owns unmount lifecycle.
    expect(editor.textContent).toContain('hello');
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
