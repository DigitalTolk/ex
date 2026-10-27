import { describe, expect, it, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput } from './MessageInput';
import { NonMemberInvitePrompt } from './NonMemberInvitePrompt';
import { ArchivedChannelNotice } from './ArchivedChannelNotice';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false, giphyAPIKey: '' } }),
}));

// The bars above or in place of the composer belong to the chat's centred
// column: in a view wider than the column they line up with the composer box
// instead of running across the whole view.

const VIEW_WIDTH = 1400;

let active: { unmount: () => Promise<void> } | null = null;
afterEach(async () => {
  if (active) await active.unmount();
  active = null;
});

async function renderAboveComposer(bar: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  active = await render(
    <QueryClientProvider client={qc}>
      <div data-testid="view" className="flex flex-col" style={{ width: VIEW_WIDTH }}>
        {bar}
        <MessageInput onSend={vi.fn()} />
      </div>
    </QueryClientProvider>,
  );
  const composer = document.querySelector('[data-message-composer]') as HTMLElement;
  await expect.element(composer).toBeVisible();
  return {
    view: document.querySelector('[data-testid="view"]')!.getBoundingClientRect(),
    column: composer.closest('[data-composer-focused]')!.getBoundingClientRect(),
    box: composer.getBoundingClientRect(),
  };
}

function expectInColumn(
  card: DOMRect,
  { view, column, box }: { view: DOMRect; column: DOMRect; box: DOMRect },
) {
  expect(column.width).toBeLessThan(view.width);
  expect(card.left).toBeGreaterThanOrEqual(column.left);
  expect(card.right).toBeLessThanOrEqual(column.right);
  expect(Math.abs(card.left + card.right - (view.left + view.right))).toBeLessThanOrEqual(1);
  // Off phones the composer box keeps one gutter, so the edges meet exactly
  // (a phone's idle composer narrows its own box).
  if (!document.documentElement.classList.contains('tier-mobile')) {
    expect(Math.abs(card.left - box.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.right - box.right)).toBeLessThanOrEqual(1);
  }
}

describe('bars around the composer', () => {
  it('keeps the add-to-channel prompt in the composer column', async () => {
    const geometry = await renderAboveComposer(
      <NonMemberInvitePrompt
        channelId="ch-1"
        channelName="incidents"
        users={[{ id: 'u-jeff', displayName: 'Jeff Example' }]}
        onDismiss={vi.fn()}
      />,
    );
    const card = document.querySelector('[data-testid="non-member-invite"]')!.getBoundingClientRect();
    expectInColumn(card, geometry);
  });

  it('keeps the archived-channel notice in the composer column', async () => {
    const geometry = await renderAboveComposer(<ArchivedChannelNotice />);
    const card = document.querySelector('[data-testid="channel-archived-notice"]')!.getBoundingClientRect();
    expectInColumn(card, geometry);
  });
});
