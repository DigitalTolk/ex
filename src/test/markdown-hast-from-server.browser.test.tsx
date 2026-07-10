import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { renderMarkdown } from '@/lib/markdown';
import type { HastNode } from '@/types';

// Fixtures captured from the actual Go renderer (`go run
// ./cmd/dump-hast`). They reflect the on-wire JSON shape — including
// the fact that omitempty omits empty `properties` and empty
// `children` from leaf nodes. Catches regressions where the
// frontend hydrator can't tolerate the server's actual output.

const plainText: HastNode = {
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'p',
      children: [{ type: 'text', value: 'hello world' }],
    },
  ],
};

const inlineFormatting: HastNode = {
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'p',
      children: [
        { type: 'element', tagName: 'strong', children: [{ type: 'text', value: 'bold' }] },
        { type: 'text', value: ' ' },
        { type: 'element', tagName: 'em', children: [{ type: 'text', value: 'italic' }] },
        { type: 'text', value: ' ' },
        { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'code' }] },
      ],
    },
  ],
};

// CRITICAL: leaf ex-* nodes have NO `children` field at all — Go's
// omitempty strips empty slices entirely. The legacy JS tests in
// markdown-hast.test.tsx always emitted `children: []` so this case
// was never exercised. A black-screen production bug is the
// consequence of the hydrator failing on this shape.
const mentionsNoChildren: HastNode = {
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'p',
      children: [
        { type: 'text', value: 'see ' },
        {
          type: 'element',
          tagName: 'ex-mention-user',
          properties: {
            'data-name': 'Alice',
            'data-user-id': 'u-1',
            'data-value': '@[u-1|Alice]',
          },
          // intentionally NO children field — mirrors Go's omitempty output
        },
        { type: 'text', value: ' and ' },
        {
          type: 'element',
          tagName: 'ex-mention-channel',
          properties: {
            'data-channel-id': 'ch-1',
            'data-slug': 'general',
            'data-value': '~[ch-1|general]',
          },
        },
      ],
    },
  ],
};

describe('renderMarkdown — server hast fixtures', () => {
  it('renders a plain-text paragraph from a real backend tree', async () => {
    const screen = await render(<>{renderMarkdown('', { tree: plainText })}</>);
    await expect.element(screen.getByText('hello world')).toBeVisible();
  });

  it('renders inline formatting (strong / em / code) — no properties field at all on those tags', async () => {
    const screen = await render(<>{renderMarkdown('', { tree: inlineFormatting })}</>);
    await expect.element(screen.getByText('bold')).toBeVisible();
    await expect.element(screen.getByText('italic')).toBeVisible();
    await expect.element(screen.getByText('code')).toBeVisible();
  });

  it('renders mentions when ex-* leaf nodes arrive without a children field', async () => {
    await render(<>{renderMarkdown('', { tree: mentionsNoChildren })}</>);
    // If the hydrator throws on missing-children leaves, React's
    // error boundary unmounts everything — the visible page goes
    // black. Asserting on the rendered mention proves the entire
    // tree survived hydration.
    const pill = document.querySelector('[data-mention-user-id="u-1"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('@Alice');
    const channelPill = document.querySelector('[data-channel-id="ch-1"]');
    expect(channelPill).not.toBeNull();
    expect(channelPill?.textContent).toBe('~general');
  });

  it('unwraps tags outside the allowlist, keeping their text children', async () => {
    const hostile: HastNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            {
              type: 'element',
              tagName: 'script',
              children: [{ type: 'text', value: 'not-executed' }],
            },
            {
              // Childless on purpose (omitempty): must unwrap to nothing
              // instead of crashing the normaliser.
              type: 'element',
              tagName: 'iframe',
              properties: { src: 'https://evil.example' },
            },
            { type: 'text', value: ' safe' },
          ],
        },
      ],
    };
    const screen = await render(<>{renderMarkdown('', { tree: hostile })}</>);
    expect(screen.container.querySelector('script, iframe')).toBeNull();
    await expect.element(screen.getByText('not-executed safe')).toBeVisible();
  });

  it('renders a bare text root (malformed server tree) as plain text', async () => {
    const textRoot = { type: 'text', value: 'plain text root' } as HastNode;
    const screen = await render(<>{renderMarkdown('', { tree: textRoot })}</>);
    await expect.element(screen.getByText('plain text root')).toBeVisible();
  });
});
