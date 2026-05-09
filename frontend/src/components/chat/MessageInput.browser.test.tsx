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

  it('renders draft image attachment previews when mobile metadata only has an image filename', async () => {
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
    expect(preview!.src).toBe(previewPNG);
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
});
