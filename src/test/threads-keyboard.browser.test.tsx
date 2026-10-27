import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageContainer } from '@/components/layout/PageContainer';
import { MessageInput } from '@/components/chat/MessageInput';
import { fireKeyboard, keyboardSettled } from '@/test/keyboard';
import { KeyboardInsetTracker } from '@/test/KeyboardInsetTracker';

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

// A reply box in a scrolling page (a thread card on /threads), not docked
// under a message list: tapping into it on a phone must bring the whole box
// above the keyboard, not just the line being typed on.

const KEYBOARD_PX = 300;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KeyboardInsetTracker />
      {/* The app root, sized as in App.tsx. */}
      <div className="flex flex-col" style={{ height: 'var(--ex-app-height, 100dvh)' }}>
        <PageContainer title="Threads" flush>
          <div style={{ height: 1200 }}>A thread</div>
          <MessageInput onSend={vi.fn()} placeholder="Reply…" />
          <div style={{ height: 1200 }}>The next thread</div>
        </PageContainer>
      </div>
    </QueryClientProvider>,
  );
}

async function frames(count: number) {
  for (let i = 0; i < count; i += 1) await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

function rect(selector: string) {
  return document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
}

afterEach(() => {
  fireKeyboard('keyboardWillHide');
});

// Phones only: the desktop project has no on-screen keyboard, and its
// composer shows its toolbar all along.
describe.skipIf(window.__EX_FORCE_DEVICE__ === 'desktop')('a reply box in a scrolling page with the keyboard up', () => {
  it('brings the whole box above the keyboard, its formatting toolbar included', async () => {
    await renderPage();
    const scroller = document.querySelector<HTMLElement>('[data-page-scroll="true"]')!;
    await expect.element(document.querySelector<HTMLElement>('[data-message-composer]')!).toBeVisible();
    // The box the reader taps sits right at the bottom of the screen.
    scroller.scrollTop += rect('[data-message-composer]').bottom - scroller.getBoundingClientRect().bottom;
    await frames(3);

    document.querySelector<HTMLElement>('[data-message-composer] [contenteditable="true"]')!.focus();
    fireKeyboard('keyboardWillShow', KEYBOARD_PX);
    await keyboardSettled(() => document.querySelector('[data-composer-focused="true"]') !== null);
    await frames(3);

    const box = rect('[data-message-composer]');
    const toolbar = rect('[data-testid="composer-toolbar-reveal"]');
    expect(toolbar.height).toBeGreaterThan(0);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight - KEYBOARD_PX + 1);
    expect(box.bottom).toBeLessThanOrEqual(scroller.getBoundingClientRect().bottom + 1);
    expect(box.top).toBeGreaterThanOrEqual(scroller.getBoundingClientRect().top - 1);
  });
});
