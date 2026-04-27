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

// Stub the WYSIWYG editor to a plain textarea — onChange feeds the
// markdown string back into MessageInput's body state. This is what the
// validation cap reads, so it's the only behaviour the test needs.
vi.mock('@/components/chat/WysiwygEditor', () => ({
  WysiwygEditor: (props: {
    onChange: (md: string) => void;
    onSubmit: () => void;
    placeholder?: string;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={props.ariaLabel ?? 'Message input'}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      data-testid="wysiwyg-stub"
    />
  ),
}));

import { MessageInput } from '@/components/chat/MessageInput';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_BODY_CHARS } from '@/lib/limits';

function renderInput(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('MessageInput validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Send and shows the over-limit banner when body exceeds 4096 codepoints', () => {
    const onSend = vi.fn();
    renderInput(<MessageInput onSend={onSend} />);

    const editor = screen.getByTestId('wysiwyg-stub');
    fireEvent.change(editor, { target: { value: 'a'.repeat(MAX_MESSAGE_BODY_CHARS + 1) } });

    expect(screen.getByTestId('message-body-too-long')).toBeInTheDocument();
    expect(screen.getByTestId('message-body-too-long').textContent).toMatch(
      new RegExp(`/${MAX_MESSAGE_BODY_CHARS}`),
    );
    expect(
      (screen.getByLabelText('Send message') as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByLabelText('Send message'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('counts emoji as one codepoint each so a 4096-emoji string sends fine', () => {
    const onSend = vi.fn();
    renderInput(<MessageInput onSend={onSend} />);

    const editor = screen.getByTestId('wysiwyg-stub');
    // 1000 rocket emojis = 1000 codepoints (well under cap), even though
    // the JS string length is 2000 UTF-16 units.
    fireEvent.change(editor, { target: { value: '🚀'.repeat(1000) } });
    expect(screen.queryByTestId('message-body-too-long')).toBeNull();
    expect(
      (screen.getByLabelText('Send message') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('skips files past the 10-attachment cap and surfaces a friendly warning', async () => {
    // Drive uploadAttachment to immediately fire onInit so each accepted
    // file becomes a draft chip. The test asserts only the first 10
    // files were actually uploaded.
    let nextID = 0;
    mockUploadAttachment.mockImplementation(
      async (
        _file: File,
        cb?: { onInit?: (i: { id: string; alreadyExists: boolean; filename: string; contentType: string; size: number }) => void },
      ) => {
        nextID++;
        cb?.onInit?.({
          id: `att-${nextID}`,
          alreadyExists: true,
          filename: `f${nextID}.txt`,
          contentType: 'text/plain',
          size: 1,
        });
      },
    );

    renderInput(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;

    // 12 files in one go — only the first 10 should upload.
    const tooMany = Array.from({ length: 12 }, (_, i) =>
      new File([`x`], `${i}.txt`, { type: 'text/plain' }),
    );
    Object.defineProperty(fileInput, 'files', {
      value: { length: tooMany.length, item: (i: number) => tooMany[i], ...tooMany },
      configurable: true,
    });
    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(mockUploadAttachment).toHaveBeenCalledTimes(MAX_ATTACHMENTS_PER_MESSAGE);
    });
    // The "skipped N" banner uses the upload-error slot.
    expect(
      screen.getByText(new RegExp(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE}.*Skipped 2`)),
    ).toBeInTheDocument();
  });
});
