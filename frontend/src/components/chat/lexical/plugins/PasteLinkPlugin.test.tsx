import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

function makeClipboard(text: string): DataTransfer {
  // jsdom DataTransfer is a thin shell — the bits this plugin reads
  // are getData/types, so a hand-rolled object matches the shape we
  // need without pulling in a real DataTransfer.
  return {
    getData: (type: string) => (type === 'text/plain' ? text : ''),
    types: ['text/plain'],
    items: { length: 0 } as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
}

describe('PasteLinkPlugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does not link the paste when nothing is selected (collapsed caret)', async () => {
    // No selection → fall through to Lexical's default text-paste so
    // the URL appears as plain text.
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} initialBody="docs" /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: makeClipboard('https://example.com'),
    });
    // The default-handler path won't insert anchor markup.
    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('a[href="https://example.com"]')).toBeNull();
    });
  });

  it('does not claim the paste when the clipboard is non-URL text', async () => {
    // Plain text paste must always fall through to Lexical's default.
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} initialBody="docs" /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: makeClipboard('not a url'),
    });
    expect(ref.current!.getElement()?.querySelector('a')).toBeNull();
  });
});
