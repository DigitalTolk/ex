import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageHitCard } from './MessageHitCard';
import type { SearchHit } from '@/hooks/useSearch';

// While a search is in flight the previous results stay on screen and
// re-render on every keystroke. Each re-render used to parse every result's
// body again — on long imported messages, a freeze per keystroke.

const parsed = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/markdown')>();
  return {
    ...actual,
    renderMarkdown: (...args: Parameters<typeof actual.renderMarkdown>) => {
      parsed.count++;
      return actual.renderMarkdown(...args);
    },
  };
});
vi.mock('@/lib/api', () => ({ apiFetch: () => Promise.resolve([]) }));

const hit: SearchHit = { id: 'm-1', score: 1, _source: { body: 'a **long** message', parentId: 'c-1', authorId: 'u-1' } };

// The search field above the results: a new query text on every keystroke.
function Results({ qc, q }: { qc: QueryClient; q: string }) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <output>{q}</output>
        <MessageHitCard hit={hit} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('MessageHitCard', () => {
  it('parses its body once, however often the search above it re-renders', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<Results qc={qc} q="" />);
    expect(await screen.findByText('long')).toBeInTheDocument();
    await waitFor(() => expect(qc.isFetching()).toBe(0));
    const before = parsed.count;
    for (const q of ['s', 'se', 'sea', 'sear']) view.rerender(<Results qc={qc} q={q} />);
    expect(screen.getByText('sear')).toBeInTheDocument();
    expect(parsed.count).toBe(before);
  });
});
