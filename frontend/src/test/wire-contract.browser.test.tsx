import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseMessage } from '@/lib/ws-schemas';
import { renderMarkdown } from '@/lib/markdown';
import type { Message } from '@/types';

// GiphyEmbed uses React Query — every render call needs a provider
// in scope. A single QC across the suite is fine; tests don't
// interact with the query cache.
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrap(children: React.ReactNode) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// Wire-format contract tests. These import the SAME JSON the backend
// emits as goldens (internal/service/wire_golden_test.go writes them
// to wire-fixtures/). A backend change to the on-wire format
// regenerates the golden; this suite then fails on the next run
// until the frontend expectations are updated to match.
//
// The "chat goes black" production bug was a wire-format mismatch
// (Go's omitempty stripped `children:[]` from leaf elements). The
// existing renderer + Zod schemas BOTH passed when fed hand-written
// JSON; only running real-backend JSON through them surfaced the bug.
// THIS file is the test surface for that class of regression.

import messageFullyPopulated from './wire-fixtures/message_fully_populated.json';
import messageMinimal from './wire-fixtures/message_minimal.json';
import messageDeleted from './wire-fixtures/message_deleted.json';
import hastAllCustomTags from './wire-fixtures/hast_all_custom_tags.json';

describe('wire-format contract: backend JSON → frontend Zod schema', () => {
  it('parses a fully-populated message without dropping fields', () => {
    const parsed = parseMessage(messageFullyPopulated);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(messageFullyPopulated.id);
    expect(parsed?.body).toBe(messageFullyPopulated.body);
    expect(parsed?.pinned).toBe(true);
    expect(parsed?.replyCount).toBe(3);
    // passthrough must preserve `rendered` so it can reach the
    // hast hydrator downstream.
    expect((parsed as Message & { rendered?: unknown })?.rendered).toBeDefined();
  });

  it('parses a deleted message (empty body, no rendered)', () => {
    const parsed = parseMessage(messageDeleted);
    expect(parsed).not.toBeNull();
    expect(parsed?.deleted).toBe(true);
    expect((parsed as Message & { rendered?: unknown })?.rendered).toBeUndefined();
  });

  it('parses a minimal message and preserves the rendered tree', () => {
    const parsed = parseMessage(messageMinimal);
    expect(parsed).not.toBeNull();
    const rendered = (parsed as Message & { rendered?: unknown }).rendered;
    expect(rendered).toBeDefined();
    expect((rendered as { type: string }).type).toBe('root');
  });
});

describe('wire-format contract: backend hast tree → frontend renderer', () => {
  it('hydrates a fully-populated message body to visible content', async () => {
    const tree = (messageFullyPopulated as { rendered: import('@/types').HastNode }).rendered;
    const screen = await render(wrap(<>{renderMarkdown(messageFullyPopulated.body, { tree })}</>));
    // Standard markdown rendered correctly.
    await expect.element(screen.getByText('Hello')).toBeVisible();
    // Mention pill survived the wire round-trip.
    const mention = document.querySelector('[data-mention-user-id="u-2"]');
    expect(mention).not.toBeNull();
    expect(mention?.textContent).toBe('@Bob');
  });

  it('hydrates the all-custom-tags fixture without crashing', async () => {
    // This is the synthetic test that catches the chat-goes-black
    // bug class: feed a real backend tree containing every ex-*
    // sentinel and verify nothing throws during hydration.
    await render(wrap(<>{renderMarkdown('', { tree: hastAllCustomTags as import('@/types').HastNode })}</>));
    // Mention, channel mention, group mention, hashtag, bare URL,
    // emoji, giphy embed — all should be in the DOM.
    expect(document.querySelector('[data-mention-user-id="u-1"]')).not.toBeNull();
    expect(document.querySelector('[data-channel-id="ch-1"]')).not.toBeNull();
    expect(document.querySelector('[data-mention-group="all"]')).not.toBeNull();
    // Bare URLs render as anchors with the protocol stripped from
    // visible text.
    const links = Array.from(document.querySelectorAll('a'));
    const example = links.find((a) => a.getAttribute('href') === 'https://example.org');
    expect(example).toBeDefined();
  });

  it('renders heading + list + blockquote from the all-tags fixture', async () => {
    const screen = await render(wrap(<>{renderMarkdown('', { tree: hastAllCustomTags as import('@/types').HastNode })}</>));
    await expect.element(screen.getByText('heading')).toBeVisible();
    await expect.element(screen.getByText('one')).toBeVisible();
    await expect.element(screen.getByText('quote')).toBeVisible();
  });

  it('renders the code fence with the server-emitted language hint', async () => {
    await render(wrap(<>{renderMarkdown('', { tree: hastAllCustomTags as import('@/types').HastNode })}</>));
    const pre = document.querySelector('pre');
    expect(pre?.getAttribute('data-language')).toBe('js');
    const code = pre?.querySelector('code');
    expect(code?.className).toContain('language-javascript');
  });
});
