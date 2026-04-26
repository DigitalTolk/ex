import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

import { MessageInput } from '@/components/chat/MessageInput';

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('MessageInput live preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides preview when input is empty', () => {
    render(<MessageInput onSend={vi.fn()} />);
    expect(screen.queryByTestId('message-input-preview')).toBeNull();
  });

  it('hides preview for plain text without formatting', () => {
    render(<MessageInput onSend={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'hello world' } });
    expect(screen.queryByTestId('message-input-preview')).toBeNull();
  });

  it('shows formatted preview when typing bold markdown', () => {
    render(<MessageInput onSend={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'this is **bold** text' } });
    const preview = screen.getByTestId('message-input-preview');
    expect(preview).toBeInTheDocument();
    expect(preview.querySelector('strong')?.textContent).toBe('bold');
  });

  it('renders headers in preview', () => {
    render(<MessageInput onSend={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: '# Big title' } });
    const preview = screen.getByTestId('message-input-preview');
    expect(preview.querySelector('h1')?.textContent).toBe('Big title');
  });

  it('updates preview live as the user types', () => {
    render(<MessageInput onSend={vi.fn()} />);
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: '*italic*' } });
    expect(screen.getByTestId('message-input-preview').querySelector('em')?.textContent).toBe('italic');
    fireEvent.change(input, { target: { value: '`code`' } });
    expect(screen.getByTestId('message-input-preview').querySelector('code')?.textContent).toBe('code');
  });

  it('honors initialBody and prefills input + shows preview', () => {
    render(<MessageInput onSend={vi.fn()} initialBody="**hi**" />);
    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe('**hi**');
    expect(screen.getByTestId('message-input-preview').querySelector('strong')?.textContent).toBe('hi');
  });

  it('renders Cancel button when onCancel is provided and triggers it on Escape', () => {
    const onCancel = vi.fn();
    render(<MessageInput onSend={vi.fn()} onCancel={onCancel} />);
    expect(screen.getByLabelText('Cancel')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('uses submitLabel as button label when provided', () => {
    render(<MessageInput onSend={vi.fn()} submitLabel="Save" initialBody="x" />);
    expect(screen.getByLabelText('Save')).toBeInTheDocument();
  });
});
