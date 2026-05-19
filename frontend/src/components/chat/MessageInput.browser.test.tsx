import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput } from './MessageInput';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

const uploadAttachmentMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false } }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useAllUsers: () => ({
    data: [
      {
        id: 'u-alice',
        displayName: 'Alice Example',
        email: 'alice@example.test',
      },
    ],
  }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: uploadAttachmentMock,
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const previewPNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

describe('MessageInput browser behavior', () => {
  it('uses a lower iPhone-style rounded composer on mobile without changing desktop shape', async () => {
    const screen = await renderWithProviders(
      <div style={{ position: 'fixed', inset: 'auto 0 0 0', width: '100%' }}>
        <MessageInput onSend={vi.fn()} />
      </div>,
    );

    const composer = document.querySelector('[data-message-composer]') as HTMLElement | null;
    expect(composer).not.toBeNull();
    await expect.element(composer!).toBeVisible();

    const styles = getComputedStyle(composer!);
    const radius = Number.parseFloat(styles.borderTopLeftRadius);
    const composerRect = composer!.getBoundingClientRect();
    const root = composer!.parentElement as HTMLElement;

    if (window.innerWidth <= 767) {
      expect(radius).toBeGreaterThanOrEqual(24);
      expect(composerRect.bottom).toBeGreaterThanOrEqual(window.innerHeight - 8);
      expect(composerRect.height).toBeLessThanOrEqual(42);
      expect(composerRect.left).toBeGreaterThanOrEqual(15);
      expect(window.innerWidth - composerRect.right).toBeGreaterThanOrEqual(15);
      expect(root).not.toBeNull();
      const rootBackground = getComputedStyle(root).backgroundColor;
      expect(rootBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(getComputedStyle(document.documentElement).backgroundColor).toBe(rootBackground);
      expect(getComputedStyle(document.body).backgroundColor).toBe(rootBackground);
      await screen.getByLabelText('Message input').click();
      await vi.waitFor(() => {
        const focusedRect = composer!.getBoundingClientRect();
        expect(focusedRect.left).toBeLessThanOrEqual(10);
        expect(window.innerWidth - focusedRect.right).toBeLessThanOrEqual(10);
        expect(focusedRect.bottom).toBeGreaterThanOrEqual(window.innerHeight - 8);
        expect(focusedRect.height).toBeGreaterThan(composerRect.height + 8);
      });
      const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
      await expect.element(toolbar).toBeVisible();
      const send = screen.getByLabelText('Send message').element();
      const sendRect = send.getBoundingClientRect();
      const sendRadius = Number.parseFloat(getComputedStyle(send).borderTopLeftRadius);
      expect(sendRadius).toBeGreaterThanOrEqual(sendRect.width / 2 - 1);
      expect(document.querySelector('[aria-label="Link"]')).toBeNull();
    } else {
      expect(radius).toBeLessThanOrEqual(12);
      expect(screen.getByLabelText('Link').element()).toBeVisible();
      const send = screen.getByLabelText('Send message').element();
      const sendRect = send.getBoundingClientRect();
      const sendRadius = Number.parseFloat(getComputedStyle(send).borderTopLeftRadius);
      expect(sendRadius).toBeLessThan(sendRect.width / 2 - 1);
    }

    expectPaintedAtCenter(composer!);
  });

  it('drops the safe-area inset and adds top breathing room inside the rounded composer once focused on mobile', async () => {
    if (window.innerWidth > 767) return;

    const screen = await renderWithProviders(
      <div style={{ position: 'fixed', inset: 'auto 0 0 0', width: '100%' }}>
        <MessageInput onSend={vi.fn()} />
      </div>,
    );

    const composerShell = document.querySelector('[data-composer-focused]') as HTMLElement | null;
    expect(composerShell).not.toBeNull();
    const idleStyles = getComputedStyle(composerShell!);
    const idlePaddingBottom = Number.parseFloat(idleStyles.paddingBottom);
    // While idle the composer reserves space for the iOS home indicator.
    expect(idlePaddingBottom).toBeGreaterThanOrEqual(4);

    await screen.getByLabelText('Message input').click();
    await vi.waitFor(() => {
      expect(composerShell!.getAttribute('data-composer-focused')).toBe('true');
    });

    // Once the keyboard is up the safe-area inset is dropped — the
    // resolved bottom padding stays at ~4px (0.25rem) regardless of
    // the device's home-indicator inset.
    const focusedStyles = getComputedStyle(composerShell!);
    expect(Number.parseFloat(focusedStyles.paddingBottom)).toBeLessThanOrEqual(6);

    // The inner editor row has an extra max-md:pt-3 so the text
    // doesn't hug the rounded composer's top edge.
    const editor = screen.getByLabelText('Message input').element() as HTMLElement;
    const editorRow = editor.closest('.flex.gap-2') as HTMLElement | null;
    expect(editorRow).not.toBeNull();
    expect(Number.parseFloat(getComputedStyle(editorRow!).paddingTop)).toBeGreaterThanOrEqual(11);
  });

  it('renders the mobile edit save action with the same fully rounded icon shape', async () => {
    if (window.innerWidth > 767) return;

    const screen = await renderWithProviders(
      <div style={{ position: 'fixed', inset: 'auto 0 0 0', width: '100%' }}>
        <MessageInput
          onSend={vi.fn()}
          onCancel={vi.fn()}
          initialBody="Edit me"
          submitLabel="Save"
        />
      </div>,
    );

    const save = screen.getByLabelText('Save').element();
    await expect.element(save).toBeVisible();
    const saveRect = save.getBoundingClientRect();
    const saveRadius = Number.parseFloat(getComputedStyle(save).borderTopLeftRadius);
    expect(saveRadius).toBeGreaterThanOrEqual(saveRect.width / 2 - 1);
    expectPaintedAtCenter(save);
  });

  it('keeps the mobile compact composer attachment-free until focus, then renders upload progress and preview', async () => {
    let completeUpload: (() => void) | undefined;
    uploadAttachmentMock.mockImplementationOnce(
      async (
        file: File,
        callbacks?: {
          onInit?: (init: { id: string; filename: string; contentType: string; size: number; alreadyExists: boolean; uploadURL: string }) => void;
          onProgress?: (fraction: number) => void;
        },
      ) => {
        callbacks?.onInit?.({
          id: 'att-uploaded-1',
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          alreadyExists: false,
          uploadURL: 'https://upload.example.test',
        });
        callbacks?.onProgress?.(0.42);
        await new Promise<void>((resolve) => {
          completeUpload = resolve;
        });
        callbacks?.onProgress?.(1);
        return {
          id: 'att-uploaded-1',
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          alreadyExists: false,
          uploadURL: 'https://upload.example.test',
        };
      },
    );

    const screen = await renderWithProviders(
      <div style={{ width: 390 }}>
        <MessageInput onSend={vi.fn()} />
      </div>,
    );

    if (window.innerWidth <= 767) {
      expect(document.querySelector('[aria-label="Attach file"]')).toBeNull();
      await screen.getByLabelText('Message input').click();
    }

    const attach = screen.getByLabelText('Attach file');
    await expect.element(attach).toBeVisible();
    expectPaintedAtCenter(attach.element());
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    const editor = screen.getByLabelText('Message input');
    if (window.innerWidth <= 767) {
      expect(toolbar.element()).toHaveAttribute('data-toolbar-placement', 'bottom');
      expect(editor.element().compareDocumentPosition(toolbar.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const file = new File(['image-bytes'], 'camera-photo.png', { type: '' });
    const data = new DataTransfer();
    data.items.add(file);
    Object.defineProperty(input!, 'files', { value: data.files, configurable: true });
    input!.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(uploadAttachmentMock).toHaveBeenCalledWith(file, expect.any(Object));
    });
    const attachments = screen.getByLabelText('Draft attachments');
    await expect.element(attachments).toBeVisible();
    expectPaintedAtCenter(attachments.element());
    await expect.element(screen.getByText('42%')).toBeVisible();
    await expect.element(screen.getByRole('progressbar', { name: 'Uploading camera-photo.png' })).toBeVisible();
    const preview = document.querySelector('[data-testid="attachment-chip-thumb"]') as HTMLImageElement | null;
    expect(preview).not.toBeNull();
    await expect.element(preview!).toBeVisible();
    expectPaintedAtCenter(preview!);
    expect(preview!.src).toMatch(/^blob:/);
    completeUpload?.();
  });

  it('renders draft image attachment previews from square thumbnails instead of full originals', async () => {
    const screen = await renderWithProviders(
      <div style={{ width: 390 }}>
        <MessageInput
          onSend={vi.fn()}
          initialDrafts={[
            {
              id: 'att-mobile-1',
              filename: 'camera-photo.png',
              contentType: 'application/octet-stream',
              size: 128,
              url: previewPNG,
              squareThumbnailURL: `${previewPNG}#square-thumb`,
              progress: 1,
            },
          ]}
        />
      </div>,
    );

    const attachments = screen.getByLabelText('Draft attachments');
    await expect.element(attachments).toBeVisible();

    const preview = document.querySelector('[data-testid="attachment-chip-thumb"]') as HTMLImageElement | null;
    expect(preview).not.toBeNull();
    await expect.element(preview!).toBeVisible();
    expectPaintedAtCenter(preview!);
    expect(preview!.src).toBe(`${previewPNG}#square-thumb`);
  });

  it('keeps the mobile edit mention popup above the composer and inside the viewport', async () => {
    if (window.innerWidth > 767) return;

    const screen = await renderWithProviders(
      <div style={{ position: 'fixed', inset: 'auto 0 0 0', width: '100%' }}>
        <MessageInput
          onSend={vi.fn()}
          onCancel={vi.fn()}
          initialBody=""
          submitLabel="Save"
        />
      </div>,
    );

    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('@a');

    const popup = screen.getByTestId('mention-popup');
    await expect.element(popup).toBeVisible();

    await vi.waitFor(() => {
      const popupRect = popup.element().getBoundingClientRect();
      const editorRect = editor.element().getBoundingClientRect();
      expect(popupRect.top).toBeGreaterThanOrEqual(0);
      expect(popupRect.bottom).toBeLessThanOrEqual(editorRect.top + 1);
      expect(popupRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    });
    expectPaintedAtCenter(popup.element());
  });

  it('pins desktop edit save and cancel actions to the formatting toolbar right edge', async () => {
    if (window.innerWidth <= 767) return;

    const screen = await renderWithProviders(
      <div style={{ width: 720 }}>
        <MessageInput
          onSend={vi.fn()}
          onCancel={vi.fn()}
          initialBody="Existing edit"
          submitLabel="Save"
        />
      </div>,
    );

    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' }).element();
    const cancel = screen.getByLabelText('Cancel').element();
    const save = screen.getByLabelText('Save').element();

    await vi.waitFor(() => {
      const toolbarRect = toolbar.getBoundingClientRect();
      const saveRect = save.getBoundingClientRect();
      const cancelRect = cancel.getBoundingClientRect();
      expect(saveRect.right).toBeGreaterThan(toolbarRect.right - 12);
      expect(cancelRect.left).toBeGreaterThan(toolbarRect.left + toolbarRect.width * 0.7);
      const saveRadius = Number.parseFloat(getComputedStyle(save).borderTopLeftRadius);
      expect(saveRadius).toBeLessThan(saveRect.width / 2 - 1);
    });
    expectPaintedAtCenter(save);
    expectPaintedAtCenter(cancel);
  });

  it('blurs the mobile editor while the emoji picker is open, keeps picker content scrollable, and refocuses after pick', async () => {
    if (window.innerWidth > 767) return;

    const screen = await renderWithProviders(
      <div style={{ position: 'fixed', inset: 'auto 0 0 0', width: '100%' }}>
        <MessageInput onSend={vi.fn()} />
      </div>,
    );

    const editor = screen.getByLabelText('Message input').element();
    await screen.getByLabelText('Message input').click();
    await vi.waitFor(() => {
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
    });

    await screen.getByLabelText('Emoji').click();
    const portal = screen.getByTestId('popover-portal');
    await expect.element(portal).toBeVisible();
    expect(portal.element()).toHaveAttribute('data-mobile-sheet', 'true');
    expect(Number.parseFloat(getComputedStyle(portal.element()).borderBottomWidth)).toBe(0);
    expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(false);

    const categoryTitle = portal.element().querySelector('.uppercase') as HTMLElement | null;
    expect(categoryTitle).not.toBeNull();
    expect(getComputedStyle(categoryTitle!).textAlign).toBe('center');
    const skinTone = portal.element().querySelector('[aria-label="Emoji skin tone"]') as HTMLElement | null;
    expect(skinTone).not.toBeNull();
    expect(getComputedStyle(skinTone!).justifyContent).toBe('center');

    const scroller = portal.element().querySelector('[data-swipe-scroll="true"]') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight);
    scroller!.scrollTop = 120;
    scroller!.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(scroller!.scrollTop).toBeGreaterThan(0);

    const tile = portal.element().querySelector('[data-testid="emoji-picker-tile"]') as HTMLElement | null;
    expect(tile).not.toBeNull();
    tile!.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="popover-portal"]')).toBeNull();
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
    });
  });

  // CTA tokens: light theme CTA is #231F20 (near-black), dark theme is
  // #DE5D83 (brand pink). Lock both so a future palette tweak can't
  // accidentally re-pink the light-mode send button.
  it('paints the send button near-black in light mode', async () => {
    function parseRGB(rgb: string): [number, number, number] | null {
      const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    }

    document.documentElement.classList.remove('dark');
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} initialBody="hello there" />,
    );
    const send = screen.getByRole('button', { name: 'Send message' }).element() as HTMLElement;
    const rgb = parseRGB(getComputedStyle(send).backgroundColor);
    expect(rgb).not.toBeNull();
    // Near-black (#231F20 → rgb(35,31,32))
    expect(rgb![0]).toBeLessThan(60);
    expect(rgb![1]).toBeLessThan(60);
    expect(rgb![2]).toBeLessThan(60);
  });

  it('paints the send button brand-pink in dark mode', async () => {
    function parseRGB(rgb: string): [number, number, number] | null {
      const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    }

    document.documentElement.classList.add('dark');
    try {
      const screen = await renderWithProviders(
        <MessageInput onSend={vi.fn()} initialBody="hello there" />,
      );
      const send = screen.getByRole('button', { name: 'Send message' }).element() as HTMLElement;
      const rgb = parseRGB(getComputedStyle(send).backgroundColor);
      expect(rgb).not.toBeNull();
      // Brand pink (#DE5D83 → rgb(222,93,131))
      expect(rgb![0]).toBeGreaterThan(180);
      expect(rgb![1]).toBeLessThan(140);
      expect(rgb![2]).toBeGreaterThan(90);
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
