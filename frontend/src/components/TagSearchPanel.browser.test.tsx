import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TagSearchPanel } from './TagSearchPanel';

const tagState = vi.hoisted(() => ({
  activeTag: null as string | null,
  tagNonce: 0,
  closeTag: vi.fn(),
}));
const searchMessagesResult = vi.hoisted(() => ({
  data: undefined as { hits: { id: string; score: number; _source: Record<string, unknown> }[] } | undefined,
  isLoading: false,
  isError: false,
  error: null as unknown,
}));

vi.mock('@/context/TagSearchContext', () => ({
  useTagState: () => tagState,
}));

vi.mock('@/hooks/useSearch', () => ({
  useSearchMessages: () => searchMessagesResult,
}));

vi.mock('@/components/search/MessageHitCard', () => ({
  MessageHitCard: ({ hit }: { hit: { id: string } }) => <div data-testid="message-hit" data-id={hit.id} />,
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TagSearchPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TagSearchPanel browser behaviour', () => {
  it('renders nothing when no activeTag is set', async () => {
    tagState.activeTag = null;
    await renderPanel();
    expect(document.querySelector('[data-testid="tag-search-panel"]')).toBeNull();
  });

  it('shows skeleton placeholders while the search is loading', async () => {
    tagState.activeTag = 'bug';
    searchMessagesResult.isLoading = true;
    searchMessagesResult.data = undefined;
    searchMessagesResult.isError = false;
    await renderPanel();
    expect(document.querySelectorAll('.space-y-2 > div').length).toBeGreaterThan(0);
  });

  it('renders an empty-state line when the search returns zero hits', async () => {
    tagState.activeTag = 'bug';
    searchMessagesResult.isLoading = false;
    searchMessagesResult.data = { hits: [] };
    searchMessagesResult.isError = false;
    const screen = await renderPanel();
    await expect.element(screen.getByText(/No messages tagged/)).toBeVisible();
  });

  it('renders one MessageHitCard per hit when results land', async () => {
    tagState.activeTag = 'bug';
    searchMessagesResult.isLoading = false;
    searchMessagesResult.data = {
      hits: [
        { id: 'h-1', score: 1, _source: {} },
        { id: 'h-2', score: 0.9, _source: {} },
      ],
    };
    searchMessagesResult.isError = false;
    await renderPanel();
    expect(document.querySelectorAll('[data-testid="message-hit"]').length).toBe(2);
  });

  it('shows the alert message when the search errors out', async () => {
    tagState.activeTag = 'bug';
    searchMessagesResult.isLoading = false;
    searchMessagesResult.isError = true;
    searchMessagesResult.error = new Error('boom');
    searchMessagesResult.data = undefined;
    const screen = await renderPanel();
    await expect.element(screen.getByText('boom')).toBeVisible();
  });
});
