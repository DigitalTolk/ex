import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Stub the Giphy SDK Grid — see GiphyPicker.test.tsx for the rationale.
vi.mock('@giphy/react-components', async () => {
  const React = await import('react');
  type GridProps = {
    fetchGifs: (offset: number) => Promise<{ data: Array<{ id: string; title: string; images: { original: { url: string; width: number; height: number } } }> }>;
    onGifClick?: (gif: unknown, e: { preventDefault: () => void }) => void;
  };
  function Grid({ fetchGifs, onGifClick }: GridProps) {
    const [gifs, setGifs] = React.useState<Array<{ id: string; title: string; images: { original: { url: string; width: number; height: number } } }>>([]);
    React.useEffect(() => {
      let alive = true;
      fetchGifs(0).then((r) => {
        if (alive) setGifs(r.data);
      });
      return () => {
        alive = false;
      };
    }, [fetchGifs]);
    return React.createElement(
      'div',
      { 'data-testid': 'grid-stub' },
      gifs.map((g) =>
        React.createElement(
          'a',
          {
            key: g.id,
            href: '#',
            'data-testid': 'giphy-tile',
            onClick: (e: { preventDefault: () => void }) => onGifClick?.(g, e),
          },
          g.title,
        ),
      ),
    );
  }
  return { Grid };
});

const giphyEnabled = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: true };
const giphyDisabled = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false };

let mockSettings: typeof giphyEnabled = giphyDisabled;

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: mockSettings }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageInput } from '@/components/chat/MessageInput';

function renderInput(onSend = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MessageInput onSend={onSend} />
    </QueryClientProvider>,
  );
}

describe('MessageInput — Giphy integration', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('hides the GIF toolbar button when Giphy is disabled', () => {
    mockSettings = giphyDisabled;
    renderInput();
    expect(screen.queryByLabelText('GIF')).toBeNull();
  });

  it('shows the GIF toolbar button when Giphy is enabled and inserts a markdown image with explicit dimensions on pick', async () => {
    mockSettings = giphyEnabled;
    vi.mocked(apiFetch).mockResolvedValue({
      data: [
        {
          id: 'g-1',
          title: 'cat',
          images: { original: { url: 'https://media.giphy.com/g-1.gif', width: 300, height: 200 } },
        },
      ],
      pagination: { total_count: 1, count: 1, offset: 0 },
      meta: { status: 200, msg: 'OK', response_id: 'r' },
    });
    renderInput();

    fireEvent.click(screen.getByLabelText('GIF'));
    const tile = await screen.findByTestId('giphy-tile');
    fireEvent.click(tile);

    await waitFor(() => {
      const editor = screen.getByLabelText('Message input');
      // The composer wraps the picked URL in `![title](url =WxH)`
      // so the renderer can reserve the layout box.
      expect(editor.textContent ?? '').toContain('https://media.giphy.com/g-1.gif');
      expect(editor.textContent ?? '').toContain('=300x200');
    });
  });
});
