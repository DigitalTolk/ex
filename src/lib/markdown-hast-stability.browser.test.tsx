import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHastTree } from './markdown-hast';
import type { HastNode } from '@/types';

// Regression: scroll-induced parent re-renders MUST NOT unmount the
// custom-tag components inside a rendered message body. If they
// unmount, every GIF's <img> gets a fresh DOM node and the browser
// loads and decodes it again (the user-reported symptom: "every pixel
// of scroll reloads all elements").
//
// The check is structural: render the same tree twice via a key-
// invalidation harness, count how many times the leaf component
// mounts. Stable identity → mount count stays at 1 across N parent
// re-renders.

// The GIF's file comes from src/test/fixtures/ohmagif, never from ohmagif.
vi.mock('@/lib/ohmagif-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ohmagif-client')>()),
  OHMAGIF_MEDIA_URL: `${window.location.origin}/src/test/fixtures/ohmagif`,
}));

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrap(children: React.ReactNode) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const gifTree: HastNode = {
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'p',
      children: [
        {
          type: 'element',
          tagName: 'ex-ohmagif',
          properties: { 'data-id': 'eTxuLnWv7C', 'data-width': '320', 'data-height': '240' },
        },
      ],
    },
  ],
};

const mentionTree: HastNode = {
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'p',
      children: [
        {
          type: 'element',
          tagName: 'ex-mention-user',
          properties: { 'data-user-id': 'u-1', 'data-name': 'Alice' },
        },
      ],
    },
  ],
};

const hashtagTree: HastNode = {
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'p',
      children: [
        { type: 'element', tagName: 'ex-hashtag', properties: { 'data-tag': 'release' } },
      ],
    },
  ],
};

// A harness that renders a tree N times via a state-driven re-render
// counter, then exposes how many times the test probe inside the tree
// has mounted vs. re-rendered.
function Harness({ tree, opts }: { tree: HastNode; opts?: Parameters<typeof renderHastTree>[1] }) {
  const [tick, setTick] = useState(0);
  return (
    <div>
      <button data-testid="bump" onClick={() => setTick((t) => t + 1)}>{tick}</button>
      {/* tick is unused inside the tree — only forces the surrounding
          render. The tree must reconcile in place, preserving the
          children's DOM nodes. */}
      <div data-tick={tick}>{renderHastTree(tree, opts)}</div>
    </div>
  );
}

describe('renderHastTree — render identity', () => {
  it("does NOT remount a GIF's <img> when the parent re-renders with the same tree", async () => {
    const screen = await render(wrap(<Harness tree={gifTree} />));

    // Tag the GIF's picture once via a data attribute and watch for the
    // SAME DOM node across re-renders (a remount would replace it).
    await expect.element(screen.getByRole('link', { name: 'GIF' })).toBeVisible();
    const beforeProbe = document.querySelector('[data-testid="gif-embed"] img') as HTMLImageElement;
    await vi.waitFor(() => expect(beforeProbe.complete && beforeProbe.naturalWidth).toBe(24));
    beforeProbe.setAttribute('data-stability-marker', 'original');

    // Trigger several parent re-renders.
    const bump = screen.getByTestId('bump').element() as HTMLButtonElement;
    bump.click();
    bump.click();
    bump.click();
    await new Promise((r) => setTimeout(r, 50));

    // If GifEmbed had unmounted, the new <img> would NOT carry our
    // data-stability-marker — it's a tag we wrote onto the original DOM
    // node only.
    expect(document.querySelector('[data-testid="gif-embed"] img')).toBe(beforeProbe);
    expect(beforeProbe.getAttribute('data-stability-marker')).toBe('original');
  });

  it('does NOT remount the user-mention pill across parent re-renders', async () => {
    const screen = await render(wrap(<Harness tree={mentionTree} opts={{ currentUserId: 'u-1' }} />));
    const pill = document.querySelector('[data-mention-user-id="u-1"]') as HTMLElement;
    pill.setAttribute('data-stability-marker', 'original');

    const bump = screen.getByTestId('bump').element() as HTMLButtonElement;
    bump.click();
    bump.click();
    await new Promise((r) => setTimeout(r, 50));

    const after = document.querySelector('[data-mention-user-id="u-1"][data-stability-marker="original"]');
    expect(after).not.toBeNull();
  });

  it('does NOT remount the hashtag button across parent re-renders', async () => {
    const onTagClick = vi.fn();
    const screen = await render(wrap(<Harness tree={hashtagTree} opts={{ onTagClick }} />));
    const btn = document.querySelector('[data-testid="hashtag-pill"]') as HTMLElement;
    btn.setAttribute('data-stability-marker', 'original');

    const bump = screen.getByTestId('bump').element() as HTMLButtonElement;
    bump.click();
    bump.click();
    await new Promise((r) => setTimeout(r, 50));

    const after = document.querySelector('[data-testid="hashtag-pill"][data-stability-marker="original"]');
    expect(after).not.toBeNull();
  });

  it('preserves the component map identity across consecutive renderHastTree calls', () => {
    // The whole point of moving HAST_COMPONENTS to module scope:
    // calling renderHastTree twice in a row must produce React
    // elements whose component type at each position is identical
    // (===). We probe that here via direct inspection of the React
    // element tree the function returns.
    const a = renderHastTree(gifTree);
    const b = renderHastTree(gifTree);
    // Both calls are wrapped in a RenderOptsContext.Provider — drill
    // down once.
    type ElementWithChildren = { props?: { children?: unknown } };
    const treeA = (a as ElementWithChildren).props?.children as ElementWithChildren;
    const treeB = (b as ElementWithChildren).props?.children as ElementWithChildren;
    // The top-level element produced by hast-util-to-jsx-runtime is
    // the <p> — its component type comes from our static map and
    // must match across calls.
    const typeOf = (n: unknown) => (n as { type?: unknown })?.type;
    expect(typeOf(treeA)).toBe(typeOf(treeB));
  });
});

