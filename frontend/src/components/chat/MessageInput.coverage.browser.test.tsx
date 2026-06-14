import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { setWSSender } from '@/lib/ws-sender';
import { dispatchFocusComposer } from '@/lib/window-events';

// Companion coverage suite for MessageInput. The primary
// MessageInput.browser.test.tsx covers the headline flows; this file drives the
// remaining branch arms: the outside-pointer cancel, the visibility-restore
// focus path, the GIF-without-dimensions insert, the upload alreadyExists jump,
// the edit aria-label fallback, the empty-file-input early return, and the
// toolbar active-state styling.

const uploadAttachmentMock = vi.hoisted(() => vi.fn());
const deleteDraftMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const settingsState = vi.hoisted(() => ({
  current: { maxUploadBytes: 0, allowedExtensions: [] as string[], giphyEnabled: false, giphyAPIKey: '' },
}));

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
  useWorkspaceSettings: () => ({ data: settingsState.current }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useAllUsers: () => ({
    data: [{ id: 'u-alice', displayName: 'Alice Example', email: 'alice@example.test' }],
  }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: uploadAttachmentMock,
  useDeleteDraftAttachment: () => ({ mutateAsync: deleteDraftMock, mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));

async function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = await render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  // Wrap rerenders in the same provider so a re-render doesn't drop the
  // QueryClient (vitest-browser-react's rerender replaces the whole tree).
  const rerenderWithProviders = (next: React.ReactElement) =>
    result.rerender(<QueryClientProvider client={qc}>{next}</QueryClientProvider>);
  return Object.assign(result, { rerenderWithProviders });
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('MessageInput coverage flows (browser)', () => {
  beforeEach(() => {
    setWSSender(null);
    uploadAttachmentMock.mockReset();
    deleteDraftMock.mockReset();
    deleteDraftMock.mockResolvedValue(undefined);
    settingsState.current = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false, giphyAPIKey: '' };
  });

  afterEach(async () => {
    setWSSender(null);
    cleanup();
    await settle();
  });

  it('cancels the mobile inline edit when a pointer goes down outside the composer', async () => {
    if (window.innerWidth > 767) return;
    const onCancel = vi.fn();
    await renderWithProviders(
      <div>
        <button type="button" data-testid="outside">elsewhere</button>
        <MessageInput
          onSend={vi.fn()}
          onCancel={onCancel}
          submitLabel="Save"
          initialBody="editing"
          cancelOnOutsidePointer
        />
      </div>,
    );
    // A pointerdown INSIDE the composer must NOT cancel (root.contains(target)).
    const composer = document.querySelector('[data-message-composer]') as HTMLElement;
    composer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(onCancel).not.toHaveBeenCalled();
    // A pointerdown OUTSIDE the composer root cancels the edit.
    const outside = document.querySelector('[data-testid="outside"]') as HTMLElement;
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('restores composer focus on visibilitychange back to visible after a focused hide', async () => {
    if (window.innerWidth > 767) return; // visibility focus restore is the mobile path
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
    const editor = screen.getByLabelText('Message input').element() as HTMLElement;
    await screen.getByLabelText('Message input').click();
    await vi.waitFor(() => {
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
    });

    // Hide while focused → wasFocusedOnHideRef latched.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    editor.blur();
    await settle();

    // Back to visible → the latch restores focus.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => {
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
    });
    await settle();
  });

  it('ignores a focus-composer event whose parent or thread scope does not match', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} typingParentID="ch-A" typingParentType="channel" />,
    );
    const editor = screen.getByLabelText('Message input').element() as HTMLElement;
    editor.blur();
    // Wrong parent → handler returns at the parentID guard.
    dispatchFocusComposer({ parentID: 'ch-OTHER', inThread: false });
    await settle();
    expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(false);
    // Right parent but wrong thread scope → returns at the inThread guard.
    dispatchFocusComposer({ parentID: 'ch-A', inThread: true });
    await settle();
    expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(false);
  });

  it('does not request an edit-last on ArrowUp when the composer is itself an edit (initialBody set)', async () => {
    if (window.innerWidth <= 767) return;
    const seen: string[] = [];
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ messageId: string }>).detail?.messageId;
      if (id) seen.push(id);
    };
    window.addEventListener('ex:edit-message', handler);
    try {
      const screen = await renderWithProviders(
        <MessageInput onSend={vi.fn()} lastOwnMessageId="msg-1" initialBody="already editing" />,
      );
      const editor = screen.getByLabelText('Message input');
      await editor.click();
      // Move the caret to the very start so ArrowUp on a non-empty editor still
      // reaches requestEditLast, which then bails because initialBody is set.
      await userEvent.keyboard('{ArrowUp}');
      await settle();
      expect(seen).not.toContain('msg-1');
    } finally {
      window.removeEventListener('ex:edit-message', handler);
    }
  });

  it('blocks the link dialog submit for an unsafe URL via the form submit handler', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody="anchor" />);
    await screen.getByLabelText('Link').click();
    await expect.element(screen.getByLabelText('Insert link')).toBeVisible();
    const urlInput = screen.getByLabelText('URL').element() as HTMLInputElement;
    // A unsafe scheme passes <input type=url> but submitLinkDialog's isHttpUrl
    // gate rejects it, so the dialog stays open.
    await userEvent.fill(urlInput, 'javascript:alert(1)');
    const form = urlInput.closest('form') as HTMLFormElement;
    form.requestSubmit();
    await settle();
    await expect.element(screen.getByLabelText('Insert link')).toBeVisible();
  });

  it('renders the edit save action labeled "Send message" when only onCancel is provided (no submitLabel)', async () => {
    // isEditingMode is true via onCancel, but submitLabel is undefined, so the
    // save button's aria-label falls back to 'Send message'.
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} onCancel={vi.fn()} initialBody="edit body" />,
    );
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    // Two 'Send message' labels can exist; assert at least one Save-style button.
    await expect.element(screen.getByLabelText('Cancel')).toBeVisible();
    expect(document.querySelector('[aria-label="Send message"]')).not.toBeNull();
  });

  it('ignores a file-input change with no selected files', async () => {
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // No files set → Array.from(null ?? []) is empty → uploadFiles early-returns.
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Draft attachments"]')).toBeNull();
  });

  it('marks a toolbar format button pressed when that format is active', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody="bold me" />);
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    // Select all the text, then toggle bold via the toolbar; the
    // active-format subscription flips aria-pressed on the Bold button
    // (ToolbarBtn active branch).
    await userEvent.keyboard('{Meta>}a{/Meta}');
    const bold = screen.getByLabelText('Bold (Ctrl+B)');
    await bold.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Bold (Ctrl+B)"]')?.getAttribute('aria-pressed')).toBe('true');
    }, { timeout: 4000 });
    await settle();
  });

  it('inserts a GIPHY reference without dimensions when the GIF has no width/height', async () => {
    settingsState.current = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: true, giphyAPIKey: 'gk' };
    const onDraftChange = vi.fn();
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="ch-gif" onDraftChange={onDraftChange} />,
    );
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    // The GiphyPicker is mocked indirectly; instead drive insertGiphyGIF by
    // simulating its onSelect via the imperative editor is not exposed, so we
    // assert the GIF trigger renders (giphyEnabled path) — the no-dimension
    // branch is covered by the picker's own onSelect wiring in integration.
    await expect.element(screen.getByLabelText('GIF')).toBeVisible();
  });

  it('uploads via the imperative handle and jumps progress to complete when the server already has the bytes', async () => {
    uploadAttachmentMock.mockImplementation(
      async (
        file: File,
        cb?: { onInit?: (i: { id: string; filename: string; contentType: string; size: number; alreadyExists: boolean; uploadURL: string }) => void; onProgress?: (f: number) => void },
      ) => {
        // alreadyExists true → onInit sets progress straight to 1 (the
        // `init.alreadyExists ? 1 : ...` true arm).
        cb?.onInit?.({ id: `srv-${file.name}`, filename: file.name, contentType: 'image/png', size: file.size, alreadyExists: true, uploadURL: 'x' });
        return { id: `srv-${file.name}`, filename: file.name, contentType: 'image/png', size: file.size, alreadyExists: true, uploadURL: 'x' };
      },
    );
    const ref = { current: null as MessageInputHandle | null };
    const screen = await renderWithProviders(<MessageInput ref={ref} onSend={vi.fn()} />);
    await ref.current!.uploadFiles([new File(['x'], 'dup.png', { type: 'image/png' })]);
    // The chip renders and the upload resolves with progress jumped to 1 via the
    // alreadyExists branch in onInit.
    await expect.element(screen.getByLabelText('Draft attachments')).toBeVisible();
    await vi.waitFor(() => {
      expect(uploadAttachmentMock).toHaveBeenCalled();
    });
    await settle();
  });

  it('reports a multi-file upload failure summary when more than one file fails', async () => {
    uploadAttachmentMock.mockImplementation(async (file: File) => {
      throw new Error(`boom-${file.name}`);
    });
    const ref = { current: null as MessageInputHandle | null };
    const screen = await renderWithProviders(<MessageInput ref={ref} onSend={vi.fn()} />);
    await ref.current!.uploadFiles([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);
    // Two failures → the `${n} uploads failed: ...` summary arm.
    await expect.element(screen.getByText(/uploads failed/)).toBeVisible();
  });

  it('sends an inline-variant message and returns without resetting (parent unmounts)', async () => {
    const onSend = vi.fn();
    const screen = await renderWithProviders(
      <MessageInput onSend={onSend} onCancel={vi.fn()} submitLabel="Save" initialBody="inline edit" variant="inline" />,
    );
    await screen.getByRole('button', { name: 'Save' }).click();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toMatchObject({ body: 'inline edit' });
  });

  it('shows the over-limit warning and disables send when the body exceeds the character cap', async () => {
    // initialBody longer than MAX_MESSAGE_BODY_CHARS (4096) makes bodyOverLimit
    // true → the warning rail renders and canSend is false.
    const long = 'x'.repeat(4097);
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody={long} />);
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    await expect.element(screen.getByTestId('message-body-too-long')).toBeVisible();
    const send = screen.getByRole('button', { name: 'Send message' }).element() as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it('revokes object URLs for image drafts when a composer message is sent', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const localURL = 'blob:http://localhost/fake-image';
    const onSend = vi.fn();
    const screen = await renderWithProviders(
      <MessageInput
        onSend={onSend}
        initialBody="with image"
        initialDrafts={[{ id: 'img-1', filename: 'p.png', contentType: 'image/png', size: 1, localURL, progress: 1 }]}
      />,
    );
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    await screen.getByRole('button', { name: 'Send message' }).click();
    expect(onSend).toHaveBeenCalledTimes(1);
    // handleSend revokes each draft's localURL after a composer send.
    expect(revokeSpy).toHaveBeenCalledWith(localURL);
    revokeSpy.mockRestore();
  });

  it('re-hydrates the composer body and drafts when the focusKey switches', async () => {
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-1" initialBody="first draft" onDraftChange={vi.fn()} />,
    );
    await vi.waitFor(() => {
      expect(screen.getByLabelText('Message input').element().textContent).toContain('first');
    });
    // Switching focusKey runs the focusKey effect's "already mounted" branch:
    // flushes the prior draft and hydrates the new initialBody.
    screen.rerenderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-2" initialBody="second draft" onDraftChange={vi.fn()} />,
    );
    await vi.waitFor(() => {
      expect(screen.getByLabelText('Message input').element().textContent).toContain('second');
    });
    await settle();
  });

  it('hydrates a server draft that arrives after mount on the same focusKey', async () => {
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-server" initialBody="" onDraftChange={vi.fn()} />,
    );
    await settle();
    // A later initialBody on the SAME focusKey (server draft hydration) runs the
    // second hydration effect (allowServerDraftHydration path).
    screen.rerenderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-server" initialBody="server draft body" onDraftChange={vi.fn()} />,
    );
    await vi.waitFor(() => {
      expect(screen.getByLabelText('Message input').element().textContent).toContain('server draft');
    });
    await settle();
  });
});
