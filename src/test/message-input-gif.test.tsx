import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiGif, apiList, json, stubOhmagif, TEST_OHMAGIF_KEY } from '@/test/ohmagif';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

// The CM6 composer sources autocomplete data from these hooks — stub them with
// static empty data so their queries don't resolve async outside act().
vi.mock('@/hooks/useConversations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConversations')>()),
  useAllUsers: () => ({ data: [] }),
}));
vi.mock('@/hooks/useChannels', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useChannels')>()),
  useChannelMembers: () => ({ data: [] }),
  useUserChannels: () => ({ data: [] }),
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

const withGifs = { maxUploadBytes: 0, allowedExtensions: [], ohmagifAPIKey: TEST_OHMAGIF_KEY };
const withoutGifs = { maxUploadBytes: 0, allowedExtensions: [] };

let mockSettings: { maxUploadBytes: number; allowedExtensions: string[]; ohmagifAPIKey?: string } = withoutGifs;

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: mockSettings }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageInput } from '@/components/chat/MessageInput';

// The real picker and ohmagif Grid, over a stubbed ohmagif API.
let spy: MockInstance<typeof fetch>;
beforeEach(() => {
  spy = stubOhmagif(() => json(apiList([apiGif('CatGif0001', { description: 'cat', width: 400, height: 300 })])));
  setMobileMatch(false);
});

// Drain the Grid's settling page inside act before each test ends.
afterEach(async () => {
  await act(async () => {});
  spy.mockRestore();
});

function renderInput(onSend = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MessageInput onSend={onSend} />
    </QueryClientProvider>,
  );
}

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe('MessageInput — GIFs', () => {
  it('has no GIF button without an ohmagif key', () => {
    mockSettings = withoutGifs;
    renderInput();
    expect(screen.queryByLabelText('GIF')).toBeNull();
  });

  it("inserts the picked GIF as its ohmagif id and its file's size, never a file address", async () => {
    mockSettings = withGifs;
    renderInput();

    fireEvent.click(screen.getByLabelText('GIF'));
    fireEvent.click(await screen.findByRole('button', { name: 'cat' }));

    await waitFor(() => {
      const editor = screen.getByLabelText('Message input');
      // The files' addresses come from the id; the size (the 400x300
      // frame and its credit strip) lets the message reserve the GIF's room.
      expect(editor.textContent ?? '').toContain('![GIF](ohmagif:CatGif0001 =400x324)');
      expect(editor.textContent ?? '').not.toContain('__ohmagif__');
    });
  });

  it('lets the portal search input receive pointer focus from the toolbar picker', async () => {
    mockSettings = withGifs;
    renderInput();

    fireEvent.click(screen.getByLabelText('GIF'));
    const search = await screen.findByLabelText('Search GIFs');
    await screen.findByRole('button', { name: 'cat' });
    const pointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

    search.dispatchEvent(pointerDown);
    search.dispatchEvent(mouseDown);

    expect(pointerDown.defaultPrevented).toBe(false);
    expect(mouseDown.defaultPrevented).toBe(false);
  });

  it('keeps the mobile GIF picker open when tapping its search field', async () => {
    setMobileMatch(true);
    mockSettings = withGifs;
    renderInput();
    const editor = screen.getByLabelText('Message input');
    fireEvent.focus(editor);
    fireEvent.click(screen.getByLabelText('GIF'));
    const search = await screen.findByLabelText('Search GIFs');
    await screen.findByRole('button', { name: 'cat' });

    fireEvent.blur(editor);
    fireEvent.pointerDown(search, { pointerType: 'touch' });
    fireEvent.focus(search);

    expect(screen.getByLabelText('Search GIFs')).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
  });
});
