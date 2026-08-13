import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BucketPicker } from '@/components/search/BucketPicker';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

function Wrap({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// The search filter chips wrap into a row, so on a phone the second chip
// already sits past the halfway mark. A left-anchored 256px panel then hangs
// off the right edge of a 390px screen with no way to reach the options —
// which no markup-level assertion can see, only the resolved rectangle.
describe('BucketPicker panel placement', () => {
  it('stays inside the viewport when its trigger sits near the right edge', async () => {
    const screen = await render(
      <Wrap>
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
          <BucketPicker
            kind="channels"
            buttonLabel="In: anywhere"
            buckets={[
              { key: 'c-1', count: 9 },
              { key: 'c-2', count: 4 },
            ]}
            onPick={vi.fn()}
          />
        </div>
      </Wrap>,
    );

    await screen.getByTestId('bucket-picker-channels').click();
    const panel = document.querySelector('[data-testid="popover-portal"]') as HTMLElement;
    await vi.waitFor(() => expect(panel.dataset.popoverMeasured).toBe('true'));

    const rect = panel.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  });
});
