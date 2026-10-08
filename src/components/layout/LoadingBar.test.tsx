import { describe, it, expect } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoadingBar } from './LoadingBar';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LoadingBar />
    </QueryClientProvider>,
  );
  return qc;
}

function hold(qc: QueryClient, key: unknown[]) {
  let finish: (v: unknown) => void = () => {};
  void qc.fetchQuery({ queryKey: key, queryFn: () => new Promise((r) => (finish = r)) });
  return (v: unknown) => act(async () => finish(v));
}

describe('LoadingBar', () => {
  it('shows while the chat a person opened is first loading, then goes', async () => {
    const qc = setup();
    const bar = screen.getByTestId('loading-bar');
    expect(bar).toHaveAttribute('data-loading', 'false');
    expect(screen.queryByRole('progressbar')).toBeNull();

    const done = hold(qc, ['channelMessages', 'ch-1', null]);
    await waitFor(() => expect(bar).toHaveAttribute('data-loading', 'true'));
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBe(bar);
    // Fades in only after a moment, so quick loads never show it.
    expect(bar.className).toContain('delay-300');
    await done({ pages: [] });
    await waitFor(() => expect(bar).toHaveAttribute('data-loading', 'false'));
  });

  it('ignores refreshing something already on screen, and loads that are not the page', async () => {
    const qc = setup();
    qc.setQueryData(['thread', 'channels/ch-1', 'root'], { items: [] });
    const refresh = hold(qc, ['thread', 'channels/ch-1', 'root']);
    const done = hold(qc, ['userChannels']);
    // A page load alongside proves the bar would have caught up by now.
    const page = hold(qc, ['conversation', 'c-1']);
    const bar = screen.getByTestId('loading-bar');
    await waitFor(() => expect(bar).toHaveAttribute('data-loading', 'true'));
    await page({ id: 'c-1' });
    await waitFor(() => expect(bar).toHaveAttribute('data-loading', 'false'));
    expect(qc.isFetching()).toBe(2);
    await done([]);
    await refresh({ items: [] });
  });
});
