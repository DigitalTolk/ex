import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { ChannelAutocomplete } from '@/components/chat/ChannelAutocomplete';

function renderPopup(query: string) {
  const onPick = vi.fn();
  const onDismiss = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onPick,
    onDismiss,
    ...render(
      <QueryClientProvider client={qc}>
        <ChannelAutocomplete
          query={query}
          anchorRect={{ left: 100, top: 100, bottom: 120, right: 200 } as DOMRect}
          onPick={onPick}
          onDismiss={onDismiss}
        />
      </QueryClientProvider>,
    ),
  };
}

describe('ChannelAutocomplete', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([
      { id: 'c1', slug: 'general', name: 'general', type: 'public', archived: false },
      { id: 'c2', slug: 'random', name: 'random', type: 'public', archived: false },
      { id: 'c3', slug: 'private-room', name: 'private-room', type: 'private', archived: false },
      { id: 'c4', slug: 'old-stuff', name: 'old-stuff', type: 'public', archived: true },
    ]);
  });

  it('lists only public, non-archived channels', async () => {
    renderPopup('');
    await waitFor(() => {
      expect(screen.getByTestId('channel-popup')).toBeInTheDocument();
    });
    const opts = screen.getAllByTestId('channel-option');
    const labels = opts.map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('general'))).toBe(true);
    expect(labels.some((l) => l?.includes('random'))).toBe(true);
    expect(labels.some((l) => l?.includes('private-room'))).toBe(false);
    expect(labels.some((l) => l?.includes('old-stuff'))).toBe(false);
  });

  it('filters by query against the slug', async () => {
    renderPopup('rand');
    await waitFor(() => {
      expect(screen.getByTestId('channel-popup')).toBeInTheDocument();
    });
    const opts = screen.getAllByTestId('channel-option');
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toContain('random');
  });

  it('clicking an option calls onPick with id+slug+name', async () => {
    const { onPick } = renderPopup('');
    await waitFor(() => {
      expect(screen.getByTestId('channel-popup')).toBeInTheDocument();
    });
    const opts = screen.getAllByTestId('channel-option');
    fireEvent.mouseDown(opts[0]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', slug: 'general' }));
  });

  it('renders nothing when there are no matches', async () => {
    apiFetchMock.mockResolvedValue([
      { id: 'c1', slug: 'general', name: 'general', type: 'public', archived: false },
    ]);
    renderPopup('zzzz-no-match');
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('channel-popup')).toBeNull();
  });

  it('ArrowDown moves the active selection and Enter picks it', async () => {
    const { onPick } = renderPopup('');
    await waitFor(() => {
      expect(screen.getByTestId('channel-popup')).toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ slug: 'random' }));
  });

  it('Escape calls onDismiss', async () => {
    const { onDismiss } = renderPopup('');
    await waitFor(() => {
      expect(screen.getByTestId('channel-popup')).toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('ArrowUp wraps to the last item', async () => {
    const { onPick } = renderPopup('');
    await waitFor(() => {
      expect(screen.getByTestId('channel-popup')).toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ slug: 'random' }));
  });
});
