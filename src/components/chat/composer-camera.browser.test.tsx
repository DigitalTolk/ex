import { describe, expect, it, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput } from './MessageInput';

// The composer's camera button, in a real browser: on a touch screen it sits
// beside the paperclip, never pushes Send out of the toolbar, and steps aside
// on the narrowest phones. A desktop never shows it.

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
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useAllUsers: () => ({ data: [] }),
}));
vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));

const touch = () => window.__EX_FORCE_DEVICE__ === 'touch';
const initialWidth = window.innerWidth;
const initialHeight = window.innerHeight;

afterEach(async () => {
  await page.viewport(initialWidth, initialHeight);
});

async function openComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={qc}>
      <div style={{ position: 'fixed', inset: 'auto 0 0 0', width: '100%' }}>
        <MessageInput onSend={vi.fn()} />
      </div>
    </QueryClientProvider>,
  );
  // On a phone the toolbar opens with the field.
  if (window.innerWidth <= 767) await screen.getByLabelText('Message input').click();
  await expect.element(screen.getByLabelText('Attach file')).toBeVisible();
  return screen;
}

// The toolbar row: everything fits, and Send's right edge is inside it.
function toolbarFits() {
  const attach = document.querySelector('[aria-label="Attach file"]') as HTMLElement;
  const row = attach.parentElement as HTMLElement;
  const send = row.querySelector('[aria-label="Send message"], [data-testid="send-button"]') as HTMLElement | null;
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  if (send) expect(send.getBoundingClientRect().right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 0.5);
}

describe('composer camera button', () => {
  it('shows beside the paperclip on a touch screen, with the toolbar still fitting', async () => {
    if (!touch()) return;
    await page.viewport(390, 844);
    const screen = await openComposer();
    const camera = screen.getByLabelText('Take photo');
    await expect.element(camera).toBeVisible();
    // Right after the paperclip, the same size.
    const attach = screen.getByLabelText('Attach file').element().getBoundingClientRect();
    const box = camera.element().getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(attach.right);
    expect(Math.round(box.height)).toBe(Math.round(attach.height));
    await expect.poll(() => toolbarFits()).toBeUndefined();
  });

  it('steps aside on the narrowest phones, so Send stays in the toolbar', async () => {
    if (!touch()) return;
    await page.viewport(320, 640);
    const screen = await openComposer();
    await expect.element(screen.getByLabelText('Take photo')).not.toBeVisible();
    await expect.poll(() => toolbarFits()).toBeUndefined();
  });

  it('is never shown on a desktop', async () => {
    if (touch()) return;
    const screen = await openComposer();
    await expect.element(screen.getByLabelText('Take photo')).not.toBeVisible();
  });
});
