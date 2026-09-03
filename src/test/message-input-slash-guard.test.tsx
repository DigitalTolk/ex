import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockRunCommand = vi.fn(); // never settles → the command stays in flight

vi.mock('@/hooks/useCommands', () => ({
  useCommands: () => ({ data: [{ name: 'meet' }] }),
  useRunCommand: () => ({ mutate: (...args: unknown[]) => mockRunCommand(...args) }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Plain-textarea composer stub, same as the validation suite.
vi.mock('@/components/chat/markdown/MarkdownComposer', () => ({
  MarkdownComposer: (props: {
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

function renderInput(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('MessageInput slash-command double-submit guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('swallows a re-submitted command while one is in flight (double Enter ≠ two meetings)', () => {
    const onSend = vi.fn();
    renderInput(<MessageInput onSend={onSend} typingParentID="ch-1" typingParentType="channel" />);

    const editor = screen.getByTestId('wysiwyg-stub');
    fireEvent.change(editor, { target: { value: '/meet' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(mockRunCommand).toHaveBeenCalledTimes(1);

    // The command never settled, so it is still pending; a second identical
    // submit must be swallowed, not started again. (Trailing space: React's
    // value tracker treats re-setting the identical string as a no-op change.)
    fireEvent.change(editor, { target: { value: '/meet ' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});
