import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';
import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/chat/WysiwygEditor';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));
vi.mock('@/hooks/useConversations', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useConversations')>('@/hooks/useConversations');
  return { ...actual, useAllUsers: () => ({ data: [] }) };
});
vi.mock('@/hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useChannels')>('@/hooks/useChannels');
  return { ...actual, useUserChannels: () => ({ data: [] }) };
});
vi.mock('@/hooks/useEmoji', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useEmoji')>('@/hooks/useEmoji');
  return { ...actual, useEmojis: () => ({ data: [] }) };
});
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>() }),
}));

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('QuoteContinuationPlugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('Enter inside a non-empty blockquote does NOT submit', async () => {
    // Slack-style continuation: pressing Enter on a populated quote line
    // stays inside the quote. Without this plugin, Lexical's default
    // QuoteNode.insertNewAfter exits to a paragraph and our top-level
    // SubmitOnEnter handler then sends the message.
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} initialBody="> hello" onSubmit={onSubmit} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    // insertText('') seeds a Lexical range selection at the end of the
    // doc — i.e., inside the quote — so the Enter handler walks
    // parents and finds $isQuoteNode. Without this, jsdom has no DOM
    // selection and Lexical falls through to top-level submit.
    act(() => {
      ref.current!.insertText('');
    });
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter on an empty quote line exits the blockquote into a paragraph', async () => {
    // Slack-style: the user finished writing the quote and presses
    // Enter on a fresh empty line to break out. Per-line emptiness —
    // the whole quote already has visible content above, so the
    // earlier "trim whole quote" check would refuse to exit.
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} initialBody={'> hello\n> '} onSubmit={onSubmit} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('');
    });
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    // The quote has been replaced/followed by a paragraph — easiest
    // proof: the editor no longer has its caret inside <blockquote>.
    await waitFor(() => {
      const root = ref.current!.getElement();
      expect(root?.querySelector('blockquote + p, p:not(blockquote p)')).not.toBeNull();
    });
  });

  it('Backspace at the start of an empty quote line exits the blockquote', async () => {
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} initialBody={'> hello\n> '} onSubmit={onSubmit} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('');
    });
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Backspace' });
    await waitFor(() => {
      const root = ref.current!.getElement();
      expect(root?.querySelector('blockquote + p, p:not(blockquote p)')).not.toBeNull();
    });
  });
});
