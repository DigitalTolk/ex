import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';

vi.unmock('@/components/chat/lexical/plugins/UserMentionsPlugin');
vi.unmock('@/components/chat/lexical/plugins/ChannelMentionsPlugin');
vi.unmock('@/components/chat/lexical/plugins/EmojiShortcutsPlugin');

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));
vi.mock('@/hooks/useConversations', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useConversations')>('@/hooks/useConversations');
  return {
    ...actual,
    useAllUsers: () => ({
      data: [{ id: 'u-1', email: 'alice@example.com', displayName: 'Alice' }],
    }),
  };
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
  usePresence: () => ({ online: new Set<string>(['u-1']) }),
}));

import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/chat/WysiwygEditor';

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('SubmitOnEnterPlugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does NOT submit while the @-mention typeahead has a highlighted option', async () => {
    // Regression for "typeahead Enter sends the message instead of
    // selecting". The typeaheads run at NORMAL priority; SubmitOnEnter
    // runs at LOW. Lexical iterates priority HIGH→LOW, so the
    // typeahead's Enter handler always claims the event first when its
    // menu has a selectable option.
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} onSubmit={onSubmit} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@al');
    });
    await waitFor(() => {
      expect(screen.getByTestId('mention-popup')).toBeInTheDocument();
      // First option auto-highlighted (preselectFirstItem default).
      expect(screen.getByRole('option', { selected: true })).toBeInTheDocument();
    });
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits on bare Enter when no typeahead is open', async () => {
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} initialBody="hi" onSubmit={onSubmit} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalled();
  });
});
