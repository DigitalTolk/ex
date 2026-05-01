import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';

vi.unmock('@/components/chat/lexical/plugins/EmojiShortcutsPlugin');

vi.mock('@/hooks/useEmoji', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useEmoji')>('@/hooks/useEmoji');
  return {
    ...actual,
    useEmojis: () => ({ data: [] }),
  };
});

import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/chat/WysiwygEditor';

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('EmojiShortcutsPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the :-emoji popup with standard shortcodes after typing :smi', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText(':smi');
    });
    await waitFor(() => {
      expect(screen.getByTestId('emoji-popup')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('emoji-option').length).toBeGreaterThan(0);
  });

  it('inserts the picked shortcode as plain text', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText(':smile');
    });
    let row: HTMLElement | undefined;
    await waitFor(() => {
      row = screen.getAllByTestId('emoji-option')[0];
      expect(row).toBeDefined();
    });
    fireEvent.mouseDown(row!);
    await waitFor(() => {
      expect(ref.current?.getMarkdown()).toMatch(/:[a-z0-9_+-]+:/);
    });
  });
});
