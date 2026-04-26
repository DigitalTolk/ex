import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MentionAutocomplete, type MentionSuggestion } from '@/components/chat/MentionAutocomplete';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function renderPopup(props: {
  query: string;
  onPick?: (s: MentionSuggestion) => void;
  onDismiss?: () => void;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MentionAutocomplete
        query={props.query}
        anchorRect={{ left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20, x: 100, y: 100, toJSON: () => ({}) } as DOMRect}
        onPick={props.onPick ?? vi.fn()}
        onDismiss={props.onDismiss ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('MentionAutocomplete', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('renders @all and @here group entries when the query is empty', () => {
    renderPopup({ query: '' });
    const opts = screen.getAllByTestId('mention-option');
    // The first <span> child of each option holds the @-name; the
    // description span is separate, so we read just the name child.
    const labels = opts.map((o) => o.querySelector('span')?.textContent);
    expect(labels).toContain('@all');
    expect(labels).toContain('@here');
  });

  it('filters group entries by prefix as the user types', () => {
    renderPopup({ query: 'al' });
    const opts = screen.getAllByTestId('mention-option');
    const labels = opts.map((o) => o.querySelector('span')?.textContent);
    expect(labels).toContain('@all');
    expect(labels).not.toContain('@here');
  });

  it('renders user matches from the search hook', async () => {
    apiFetchMock.mockResolvedValueOnce([
      { id: 'u-1', email: 'a@x.com', displayName: 'Alice' },
      { id: 'u-2', email: 'b@x.com', displayName: 'Bob' },
    ]);
    renderPopup({ query: 'al' });
    await waitFor(() => {
      const texts = screen.getAllByTestId('mention-option').map((l) => l.textContent ?? '');
      expect(texts.some((t) => t.startsWith('@Alice'))).toBe(true);
    });
    const texts = screen.getAllByTestId('mention-option').map((l) => l.textContent ?? '');
    expect(texts.some((t) => t.startsWith('@Bob'))).toBe(true);
  });

  it('Enter picks the highlighted suggestion', async () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    await screen.findAllByTestId('mention-option');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
    // The first item is the @all group entry (groups come first).
    expect(onPick.mock.calls[0][0]).toEqual({ kind: 'group', group: 'all' });
  });

  it('ArrowDown advances the active row', async () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toEqual({ kind: 'group', group: 'here' });
  });

  it('ArrowUp wraps from the first row', () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'Enter' });
    // Wrapping from index 0 → last group entry (@here).
    expect(onPick.mock.calls[0][0]).toEqual({ kind: 'group', group: 'here' });
  });

  it('Escape dismisses the popup', () => {
    const onDismiss = vi.fn();
    renderPopup({ query: '', onDismiss });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('clicking an option picks it and prevents focus loss', () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    const opts = screen.getAllByTestId('mention-option');
    fireEvent.mouseDown(opts[0]);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('Tab also picks the active suggestion', () => {
    const onPick = vi.fn();
    renderPopup({ query: '', onPick });
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(onPick).toHaveBeenCalled();
  });

  it('renders nothing when there are zero suggestions', () => {
    // A query that doesn't match @all or @here AND no users → empty list.
    apiFetchMock.mockResolvedValueOnce([]);
    renderPopup({ query: 'xyz' });
    expect(screen.queryByTestId('mention-popup')).toBeNull();
  });
});
