import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';

vi.unmock('@/components/chat/lexical/plugins/EmojiShortcutsPlugin');

const authMock = vi.hoisted(() => ({
  skinTone: '' as '' | 'medium',
}));

vi.mock('@/hooks/useEmoji', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useEmoji')>('@/hooks/useEmoji');
  return {
    ...actual,
    useEmojis: () => ({ data: [] }),
  };
});

vi.mock('@/context/AuthContext', async () => {
  const actual = await vi.importActual<typeof import('@/context/AuthContext')>('@/context/AuthContext');
  return {
    ...actual,
    useOptionalAuth: () => ({
      user: authMock.skinTone ? { emojiSkinTone: authMock.skinTone } : null,
    }),
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
    authMock.skinTone = '';
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

  it('auto-appends the profile skin tone for supported standard emoji picks', async () => {
    authMock.skinTone = 'medium';
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText(':hand');
    });
    let row: HTMLElement | undefined;
    await waitFor(() => {
      row = screen.getAllByTestId('emoji-option')[0];
      expect(row).toBeDefined();
    });
    fireEvent.mouseDown(row!);
    await waitFor(() => {
      expect(ref.current?.getMarkdown()).toMatch(/:[a-z0-9_+-]+::skin-tone-3:/);
    });
  });

  it('previews standard emoji with the profile skin tone', async () => {
    authMock.skinTone = 'medium';
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText(':thumbsup');
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('emoji-option')[0].textContent).toContain('👍🏽');
    });
  });

  it('finds raised_hands when searching with an underscore prefix', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText(':raised_');
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId('emoji-option').map((row) => row.textContent ?? '');
      expect(rows).toContain('🙌:raised_hands:');
      expect(rows.some((row) => row.includes(':raising_hands:'))).toBe(false);
    });
  });

  it('uses the same generated shortcode names as picker and native normalization', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText(':grin_squint');
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId('emoji-option').map((row) => row.textContent ?? '');
      expect(rows).toContain('😆:grin_squint_face:');
      expect(rows.some((row) => row.includes(':laughing:'))).toBe(false);
    });
  });
});
