import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';

vi.unmock('@/components/chat/lexical/plugins/ChannelMentionsPlugin');

vi.mock('@/hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useChannels')>('@/hooks/useChannels');
  return {
    ...actual,
    useUserChannels: () => ({
      data: [
        { channelID: 'c-1', channelName: 'general', channelType: 'public', role: 1 },
        { channelID: 'c-2', channelName: 'random', channelType: 'public', role: 1 },
      ],
    }),
  };
});

import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/chat/WysiwygEditor';

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('ChannelMentionsPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the ~-channel popup and lists matching channels', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('~gen');
    });
    await waitFor(() => {
      expect(screen.getByTestId('channel-popup')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('channel-option');
    expect(rows.some((r) => r.textContent?.includes('general'))).toBe(true);
  });

  it('inserts a channel pill on click', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('~gen');
    });
    let row: HTMLElement | undefined;
    await waitFor(() => {
      row = screen.getAllByTestId('channel-option').find((r) =>
        r.textContent?.includes('general'),
      );
      expect(row).toBeDefined();
    });
    fireEvent.mouseDown(row!);
    await waitFor(() => {
      expect(ref.current?.getElement()?.querySelector('span.channel-mention[data-channel-id="c-1"]')).not.toBeNull();
    });
    expect(ref.current?.getMarkdown()).toContain('~[c-1|general]');
  });
});
