import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReorderSidebar } from './useSidebar';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  // Strict-ESM: the import graph also needs ApiError etc. from this module.
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Move-request arms the drag suites never hit: a drop at the very start of a
// section carries NO after-anchor (afterType/afterID default to ''), and a
// server reply without `updates` must coerce to an empty batch, not crash.

let active: { unmount: () => Promise<void> } | null = null;
afterEach(async () => {
  if (active) await active.unmount();
  active = null;
});
beforeEach(() => {
  apiFetchMock.mockReset();
});

function Probe() {
  const reorder = useReorderSidebar();
  return (
    <button
      data-testid="go"
      data-status={reorder.status}
      data-result={reorder.data === undefined ? '' : JSON.stringify(reorder.data)}
      style={{ width: 80, height: 32 }}
      onClick={() =>
        reorder.mutate({
          // No categoryID / afterType / afterID: an anchor-less lead drop.
          move: { itemType: 'channel', itemID: 'ch-1', section: 'channels' },
          updates: [],
        })
      }
    />
  );
}

describe('useReorderSidebar (anchor-less move)', () => {
  it('defaults the missing anchor fields to empty strings and tolerates a reply without updates', async () => {
    apiFetchMock.mockResolvedValue({}); // no `updates` in the reply
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    active = screen;

    await screen.getByTestId('go').click();
    await expect.element(screen.getByTestId('go')).toHaveAttribute('data-status', 'success');
    await expect.element(screen.getByTestId('go')).toHaveAttribute('data-result', '[]');

    const call = apiFetchMock.mock.calls.find(([url]) => url === '/api/v1/sidebar/move');
    expect(call).toBeDefined();
    expect(JSON.parse((call![1] as { body: string }).body)).toMatchObject({
      itemType: 'channel',
      itemID: 'ch-1',
      section: 'channels',
      categoryID: '',
      afterType: '',
      afterID: '',
    });
  });
});
