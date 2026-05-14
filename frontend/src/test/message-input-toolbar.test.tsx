import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockUploadAttachment = vi.fn();
const mockDeleteDraftMutateAsync = vi.fn().mockResolvedValue(undefined);
const workspaceSettings = vi.hoisted(() => ({
  current: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false, giphyAPIKey: '' },
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  useDeleteDraftAttachment: () => ({ mutateAsync: mockDeleteDraftMutateAsync, mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));

const { TestApiError } = vi.hoisted(() => {
  class TestApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return { TestApiError };
});
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: TestApiError,
  getAccessToken: vi.fn(() => null),
  setAccessToken: vi.fn(),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: workspaceSettings.current }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

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

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe('MessageInput toolbar buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceSettings.current = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false, giphyAPIKey: '' };
    setMobileMatch(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps quote and list toolbar buttons on desktop', async () => {
    setMobileMatch(false);
    renderWithClient(<MessageInput onSend={vi.fn()} initialBody="hello" />);
    await screen.findByLabelText('Message input');

    expect(screen.getByLabelText('Quote')).toBeInTheDocument();
    expect(screen.getByLabelText('List')).toBeInTheDocument();
    expect(screen.getByLabelText('Numbered list')).toBeInTheDocument();
    expect(screen.getByLabelText('Link')).toBeInTheDocument();
  });

  it('keeps desktop attachment beside media actions and send on the toolbar right edge', async () => {
    workspaceSettings.current = {
      maxUploadBytes: 0,
      allowedExtensions: [],
      giphyEnabled: true,
      giphyAPIKey: 'browser-key',
    };
    renderWithClient(<MessageInput onSend={vi.fn()} initialBody="hello" />);

    const toolbar = await screen.findByRole('toolbar', { name: 'Formatting' });
    const buttonLabels = Array.from(toolbar.querySelectorAll('button'))
      .map((button) => button.getAttribute('aria-label'));

    expect(buttonLabels.indexOf('GIF')).toBeLessThan(buttonLabels.indexOf('Attach file'));
    expect(buttonLabels.indexOf('Attach file')).toBeLessThan(buttonLabels.indexOf('Send message'));
    expect(screen.getByLabelText('Send message').closest('[role="toolbar"]')).toBe(toolbar);
    expect(screen.getAllByLabelText('Send message')).toHaveLength(1);
  });

  it('removes quote, list, and link toolbar buttons from the focused mobile composer', async () => {
    setMobileMatch(true);
    renderWithClient(<MessageInput onSend={vi.fn()} initialBody="hello" />);
    fireEvent.focus(await screen.findByLabelText('Message input'));

    expect(screen.queryByLabelText('Quote')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('List')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Numbered list')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Link')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Bold (Ctrl+B)')).toBeInTheDocument();
  });

  it('keeps the focused mobile toolbar alive while tapping formatting buttons', async () => {
    setMobileMatch(true);
    renderWithClient(<MessageInput onSend={vi.fn()} initialBody="hello" />);
    const editor = await screen.findByLabelText('Message input');
    fireEvent.focus(editor);

    const bold = screen.getByLabelText('Bold (Ctrl+B)');
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bold.dispatchEvent(mouseDown);

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    fireEvent.click(bold);
    await waitFor(() => {
      expect(editor.querySelector('.font-semibold')).not.toBeNull();
    });
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

  it('silently swallows a 409 conflict (SHA still referenced) on draft remove', async () => {
    // 409 is the legitimate "still referenced" path — the chip is
    // already gone, the server kept the bytes for another message,
    // user-visible state is correct. Errors with any other status
    // surface via the upload-error rail (covered separately).
    mockDeleteDraftMutateAsync.mockRejectedValueOnce(new TestApiError(409, 'still referenced'));
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
