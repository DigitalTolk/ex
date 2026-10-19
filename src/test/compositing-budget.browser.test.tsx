import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { UnreadBanner } from '@/components/chat/UnreadMarkers';
import { NoticeCard } from '@/components/chat/NoticeCardChrome';
import { LoadingBar } from '@/components/layout/LoadingBar';
import { SCROLL_FADE_BOTTOM, SCROLL_FADE_TOP } from '@/lib/scroll-fade';

// What a phone's GPU is asked to keep. A backdrop blur makes its element a
// layer of its own that re-samples everything behind it on every frame of a
// scroll or a slide, and an animation — even a paused one — keeps a layer
// too. Repeated per message (each code block's copy button was blurred, even
// where it was invisible), they piled up until a long chat crashed the page.

const blurred = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter((el) => {
    const style = getComputedStyle(el);
    const value = style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
    return value !== '' && value !== 'none';
  });

describe('compositing budget of a conversation', () => {
  it('a chat full of code, with its banner and notices, blurs nothing', async () => {
    await render(
      <div style={{ position: 'relative', width: 360 }}>
        <UnreadBanner count={3} onJump={vi.fn()} onMarkRead={vi.fn()} />
        {Array.from({ length: 5 }, (_, i) => (
          <CodeBlock key={i} code={`const a${i} = ${i};\n`} language="ts" />
        ))}
        <NoticeCard accent="approval" testID="notice" header="Approve">
          body
        </NoticeCard>
      </div>,
    );
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="code-copy-button"]')).toHaveLength(5));
    expect(blurred()).toEqual([]);
  });

  // The sidebar's lists fade under the header, the Activity filters and the
  // account strip — fades that stay mounted (at opacity 0) while unscrolled.
  it("the sidebar's scroll fades blur nothing", async () => {
    await render(
      <div style={{ position: 'relative', width: 336, height: 400 }}>
        <div className={`${SCROLL_FADE_TOP} top-0`} />
        <div className={`${SCROLL_FADE_BOTTOM} bottom-0`} />
      </div>,
    );
    expect(blurred()).toEqual([]);
  });

  it('the loading line only animates while something is loading', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <LoadingBar />
      </QueryClientProvider>,
    );
    const bar = document.querySelector('[data-testid="loading-bar"]') as HTMLElement;
    expect(bar.getAnimations({ subtree: true })).toHaveLength(0);

    let finish: (v: unknown) => void = () => {};
    void qc.fetchQuery({ queryKey: ['channelMessages', 'ch-1'], queryFn: () => new Promise((r) => (finish = r)) });
    await vi.waitFor(() => expect(bar.dataset.loading).toBe('true'));
    await vi.waitFor(() => expect(bar.firstElementChild!.getAnimations().length).toBeGreaterThan(0));
    finish({ pages: [] });
    await vi.waitFor(() => expect(bar.dataset.loading).toBe('false'));
    await vi.waitFor(() => expect(bar.firstElementChild!.getAnimations()).toHaveLength(0));
  });
});
