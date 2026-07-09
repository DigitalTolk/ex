import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { MAX_MESSAGE_BODY_CHARS } from '@/lib/limits';
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
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
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

// Same GIPHY doubles as GiphyPicker.browser.test: the fetch client resolves
// empty pages and the Grid exposes a deterministic pick button, so the REAL
// GiphyPicker → onSelect → insertGiphyGIF wiring runs without network.
vi.mock('@giphy/js-fetch-api', () => ({
  GiphyFetch: class GiphyFetch {
    trending() {
      return Promise.resolve({ data: [], pagination: { total_count: 0, count: 0, offset: 0 }, meta: { status: 200, msg: 'OK', response_id: '' } });
    }

    search() {
      return Promise.resolve({ data: [], pagination: { total_count: 0, count: 0, offset: 0 }, meta: { status: 200, msg: 'OK', response_id: '' } });
    }
  },
}));

vi.mock('@giphy/react-components', () => ({
  Grid: ({ onGifClick }: { onGifClick: (gif: unknown, event: Event) => void }) => (
    <button
      type="button"
      data-testid="pick-gif"
      onClick={() => onGifClick({ id: 'gif-77', title: 'Test GIF', images: { original: { width: '320', height: '180' } } }, new Event('click'))}
    >
      Pick GIF
    </button>
  ),
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

  it('a composer waking from a LONG sleep drops the local-edit claim and mirrors the server clear', async () => {
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-sleep" initialBody="" onDraftChange={vi.fn()} />,
    );
    // A stray wake with no prior hide is a no-op (hiddenAt === 0 arm).
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('typed days ago');
    await settle();

    const base = Date.now();
    const dateNow = vi.spyOn(Date, 'now');
    try {
      dateNow.mockReturnValue(base);
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      // …a week passes with the tab asleep…
      dateNow.mockReturnValue(base + 7 * 24 * 60 * 60 * 1000);
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      dateNow.mockRestore();
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }

    // The scope's draft was cleared elsewhere while this tab slept: the
    // expired claim lets the mirror empty the zombie buffer.
    screen.rerenderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-sleep" initialBody="" onDraftChange={vi.fn()} />,
    );
    await vi.waitFor(() => {
      expect((screen.getByLabelText('Message input').element().textContent ?? '').trim()).toBe('');
    });
    await settle();
  });

  it('mirrors an attachments-only server draft (empty body) into an empty composer', async () => {
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-att" initialBody="" onDraftChange={vi.fn()} />,
    );
    await settle();
    const chip = {
      id: 'att-1',
      filename: 'spec.pdf',
      contentType: 'application/pdf',
      size: 10,
      progress: 1,
    };
    // Same focusKey, empty body, one attachment — the mirror applies it and
    // the focus rule evaluates its attachments-only arm.
    screen.rerenderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-att" initialBody="" initialDrafts={[chip]} onDraftChange={vi.fn()} />,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('spec.pdf');
    });
    await settle();
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
    // (ToolbarBtn active branch). Select via the CodeMirror view rather than a
    // keyboard shortcut: CM binds select-all to Mod-a (Cmd on macOS, Ctrl on
    // Linux), so `{Meta>}a` only works on macOS — on Linux CI it selects
    // nothing, bold wraps an empty `****`, and no StrongEmphasis node forms.
    const view = EditorView.findFromDOM(editor.element() as HTMLElement)!;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    const bold = screen.getByLabelText('Bold (Ctrl+B)');
    await bold.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Bold (Ctrl+B)"]')?.getAttribute('aria-pressed')).toBe('true');
    }, { timeout: 4000 });
    await settle();
  });

  it('inserts a GIPHY reference into the composer when a GIF is picked', async () => {
    settingsState.current = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: true, giphyAPIKey: 'gk' };
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    await expect.element(screen.getByLabelText('GIF')).toBeVisible();
    // Open the (real) GiphyPicker — its mocked Grid exposes a pick button —
    // and pick a GIF: insertGiphyGIF writes the stable content-ID reference
    // (with layout dimensions) into the buffer and refocuses the editor.
    await screen.getByLabelText('GIF').click();
    await screen.getByTestId('pick-gif').click();
    await vi.waitFor(() => {
      const view = EditorView.findFromDOM(screen.getByLabelText('Message input').element() as HTMLElement)!;
      expect(view.state.doc.toString()).toContain('![GIPHY](giphy:gif-77 =320x180)');
    });
    await settle();
  });

  it('flushes the draft with keepalive when the page is torn down (pagehide)', async () => {
    const onDraftChange = vi.fn();
    await renderWithProviders(
      <MessageInput onSend={vi.fn()} initialBody="teardown draft" onDraftChange={onDraftChange} />,
    );
    await settle();
    onDraftChange.mockClear();
    // pagehide → flushDraft({ keepalive: true }): the save must ride a
    // keepalive fetch because the page is dying.
    window.dispatchEvent(new Event('pagehide'));
    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'teardown draft' }),
      { notify: true, keepalive: true },
    );
  });

  it('applies italic, strikethrough, and code marks from the toolbar', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody="fmt me" />);
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    const view = EditorView.findFromDOM(editor.element() as HTMLElement)!;
    // Select all, then wrap with each inline mark in turn. applyMark keeps the
    // inner text selected, so each subsequent mark nests inside the previous.
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    await screen.getByLabelText('Italic (Ctrl+I)').click();
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('*fmt me*'));
    await screen.getByLabelText('Strikethrough').click();
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('~~fmt me~~'));
    await screen.getByLabelText('Code (Ctrl+E)').click();
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('`fmt me`'));
    await settle();
  });

  it('applies quote, bullet-list, and numbered-list blocks from the toolbar', async () => {
    if (window.innerWidth <= 767) return; // block buttons are desktop-only
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody="block line" />);
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    const view = EditorView.findFromDOM(editor.element() as HTMLElement)!;
    const resetDoc = (text: string) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
    await screen.getByLabelText('Quote').click();
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('> '));
    resetDoc('bullet line');
    // 'List' is a prefix of 'Numbered list' — exact-match to satisfy strict mode.
    await screen.getByRole('button', { name: 'List', exact: true }).click();
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('- '));
    resetDoc('numbered line');
    await screen.getByLabelText('Numbered list').click();
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain('1. '));
    await settle();
  });

  it('opens the hidden file input from the toolbar attach button', async () => {
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    // preventDefault stops the native file chooser from actually opening in
    // the test browser while still proving the button forwarded the click.
    const clickSpy = vi.fn((e: Event) => e.preventDefault());
    fileInput.addEventListener('click', clickSpy);
    try {
      await screen.getByLabelText('Attach file').click();
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      fileInput.removeEventListener('click', clickSpy);
    }
  });

  it('inserts a link using custom text typed into the dialog Text field', async () => {
    if (window.innerWidth <= 767) return; // the Link button is desktop-only
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
    await screen.getByLabelText('Link').click();
    await expect.element(screen.getByLabelText('Insert link')).toBeVisible();
    // Typing into the Text field drives the controlled setLinkText onChange.
    await screen.getByLabelText('Text').fill('Docs');
    await screen.getByLabelText('URL').fill('https://example.com/docs');
    await screen.getByRole('button', { name: 'Insert' }).click();
    await vi.waitFor(() => {
      const view = EditorView.findFromDOM(screen.getByLabelText('Message input').element() as HTMLElement)!;
      expect(view.state.doc.toString()).toContain('[Docs](https://example.com/docs)');
    });
    await settle();
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
    // initialBody longer than MAX_MESSAGE_BODY_CHARS makes bodyOverLimit
    // true → the warning rail renders and canSend is false.
    const long = 'x'.repeat(MAX_MESSAGE_BODY_CHARS + 1);
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

  it('does not server-hydrate once the user has locally edited the draft', async () => {
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-edit" initialBody="" onDraftChange={vi.fn()} />,
    );
    // Type locally → locallyEditedDraftRef true and body !== ''.
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('my local text');
    await settle();
    // A late server draft on the same key must NOT clobber the local edit (the
    // locallyEditedDraftRef / body!=='' guards short-circuit the hydration).
    screen.rerenderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="conv-edit" initialBody="server clobber" onDraftChange={vi.fn()} />,
    );
    await settle();
    expect(screen.getByLabelText('Message input').element().textContent).toContain('my local text');
    expect(screen.getByLabelText('Message input').element().textContent).not.toContain('server clobber');
  });

  it('does not dispatch edit-last on ArrowUp when there is no candidate message', async () => {
    if (window.innerWidth <= 767) return;
    const seen: string[] = [];
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ messageId: string }>).detail?.messageId;
      if (id) seen.push(id);
    };
    window.addEventListener('ex:edit-message', handler);
    try {
      // No lastOwnMessageId → requestEditLast returns false on its
      // `!lastOwnMessageId` arm and ArrowUp is left to the editor default.
      const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
      const editor = screen.getByLabelText('Message input');
      await editor.click();
      await userEvent.keyboard('{ArrowUp}');
      await settle();
      expect(seen).toHaveLength(0);
    } finally {
      window.removeEventListener('ex:edit-message', handler);
    }
  });

  it('does nothing when Enter submits an empty composer (handleSend canSend false)', async () => {
    if (window.innerWidth <= 767) return; // Enter-submits only on desktop
    const onSend = vi.fn();
    const screen = await renderWithProviders(<MessageInput onSend={onSend} />);
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    // Enter on an empty composer → onSubmit → handleSend, which bails on
    // `!canSend` (nothing to send).
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not restore focus on visibilitychange→visible when the editor was not focused at hide', async () => {
    if (window.innerWidth > 767) return;
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
    const editor = screen.getByLabelText('Message input').element() as HTMLElement;
    editor.blur();
    // Hide while NOT focused → wasFocusedOnHideRef stays false.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    // Visible again → the `&& wasFocusedOnHideRef.current` false arm: no refocus.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(false);
  });

  it('removes an image draft, revoking its object URL, and surfaces a non-409 failure', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    deleteDraftMock.mockRejectedValueOnce(new Error('server exploded'));
    const localURL = 'blob:http://localhost/draft-image';
    const screen = await renderWithProviders(
      <MessageInput
        onSend={vi.fn()}
        initialDrafts={[{ id: 'img-rm', filename: 'p.png', contentType: 'image/png', size: 1, localURL, progress: 1 }]}
      />,
    );
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    await screen.getByRole('button', { name: /Remove/ }).click();
    // removeDraft revokes the image's object URL and surfaces the non-409 error.
    expect(revokeSpy).toHaveBeenCalledWith(localURL);
    await expect.element(screen.getByText('server exploded')).toBeVisible();
    revokeSpy.mockRestore();
  });

  it('prevents default on toolbar mousedown/pointerdown so focus stays in the editor', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody="x" />);
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' }).element();
    // A mousedown / pointerdown that targets a toolbar child is preventDefaulted
    // (keeps the contenteditable selection). Use a button inside the toolbar.
    const child = toolbar.querySelector('button') as HTMLElement;
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    child.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
    const pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    child.dispatchEvent(pd);
    expect(pd.defaultPrevented).toBe(true);
  });

  it('hides the GIF trigger when GIPHY is enabled but the API key is empty', async () => {
    // giphyEnabled = (giphyEnabled ?? false) && giphyAPIKey !== '' → the
    // `&& apiKey !== ''` false arm: flag on but no key → no GIF button.
    settingsState.current = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: true, giphyAPIKey: '' };
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody="x" />);
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    await expect.element(screen.getByLabelText('Attach file')).toBeVisible();
    expect(document.querySelector('[aria-label="GIF"]')).toBeNull();
  });

  it('throttles rapid typing so a second keystroke within the window emits no extra frame', async () => {
    if (window.innerWidth <= 767) return;
    const frames: string[] = [];
    setWSSender((f) => frames.push(f));
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} typingParentID="ch-throttle" typingParentType="channel" />,
    );
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    // Type three characters back-to-back. The first emits one typing frame;
    // the next two stay within TYPING_PING_INTERVAL_MS, so emitTyping returns
    // at its `now - last < INTERVAL` guard (no new frame). Freeze Date.now
    // (the clock that guard reads) across the burst: under full-suite CPU
    // saturation the fill() round-trips can genuinely drift past the 3s
    // window, which used to emit a legitimate second frame and flake this
    // test — frozen time keeps the "within the window" premise true by
    // construction while still exercising the real guard.
    const realNow = Date.now;
    try {
      const frozen = realNow();
      Date.now = () => frozen;
      await editor.fill('a');
      await editor.fill('ab');
      await editor.fill('abc');
    } finally {
      Date.now = realNow;
    }
    await vi.waitFor(() => expect(frames.length).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.length).toBe(1);
    await settle();
  });

  it('emits a typing frame without a parentMessageID when no thread root is set', async () => {
    if (window.innerWidth <= 767) return;
    const frames: string[] = [];
    setWSSender((f) => frames.push(f));
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} typingParentID="ch-2" typingParentType="channel" />,
    );
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('typing here');
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThanOrEqual(1);
    });
    const frame = JSON.parse(frames[0]);
    // The `if (typingThreadRootID)` false arm: no parentMessageID key.
    expect(frame.parentMessageID).toBeUndefined();
    expect(frame).toMatchObject({ type: 'typing', parentID: 'ch-2', parentType: 'channel' });
    await settle();
  });

  it('skips uploading when the per-message attachment cap is already reached', async () => {
    const ref = { current: null as MessageInputHandle | null };
    const drafts = Array.from({ length: 10 }, (_, i) => ({
      id: `pre-${i}`, filename: `f${i}.png`, contentType: 'image/png', size: 1,
    }));
    const screen = await renderWithProviders(
      <MessageInput ref={ref} onSend={vi.fn()} initialDrafts={drafts} />,
    );
    if (window.innerWidth <= 767) {
      await screen.getByLabelText('Message input').click();
    }
    // remaining = max(0, 10 - 10) = 0 → files sliced to [] → the
    // `if (files.length === 0) return;` early-out after the over-cap warning.
    await ref.current!.uploadFiles([new File(['x'], 'extra.png', { type: 'image/png' })]);
    await settle();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
    await expect.element(screen.getByText(/Skipped/)).toBeVisible();
  });

  it('uploads a non-image file without creating an object-URL preview', async () => {
    uploadAttachmentMock.mockImplementation(
      async (
        file: File,
        cb?: { onInit?: (i: { id: string; filename: string; contentType: string; size: number; alreadyExists: boolean; uploadURL: string }) => void; onProgress?: (f: number) => void },
      ) => {
        cb?.onInit?.({ id: `srv-${file.name}`, filename: file.name, contentType: 'application/pdf', size: file.size, alreadyExists: false, uploadURL: 'x' });
        cb?.onProgress?.(1);
        return { id: `srv-${file.name}`, filename: file.name, contentType: 'application/pdf', size: file.size, alreadyExists: false, uploadURL: 'x' };
      },
    );
    const ref = { current: null as MessageInputHandle | null };
    const screen = await renderWithProviders(<MessageInput ref={ref} onSend={vi.fn()} />);
    // Non-image → isImageAttachment false → the optimistic chip's localURL is
    // undefined (the `: undefined` arm).
    await ref.current!.uploadFiles([new File(['doc'], 'report.pdf', { type: 'application/pdf' })]);
    await expect.element(screen.getByLabelText('Draft attachments')).toBeVisible();
    expect(document.querySelector('[data-testid="attachment-chip-thumb"]')).toBeNull();
    await settle();
  });

  it('drops a failed non-image upload chip without revoking a (nonexistent) object URL', async () => {
    // A non-image file has no localURL, so the failure-cleanup `if
    // (target?.localURL)` takes its falsy arm (nothing to revoke).
    uploadAttachmentMock.mockImplementation(async () => {
      throw new Error('pdf upload failed');
    });
    const ref = { current: null as MessageInputHandle | null };
    const screen = await renderWithProviders(<MessageInput ref={ref} onSend={vi.fn()} />);
    await ref.current!.uploadFiles([new File(['doc'], 'doc.pdf', { type: 'application/pdf' })]);
    await expect.element(screen.getByText('pdf upload failed')).toBeVisible();
    // The failed chip was removed; no draft attachments remain.
    expect(document.querySelector('[aria-label="Draft attachments"]')).toBeNull();
    await settle();
  });

  it('reports a generic message when an upload rejects with a non-Error value', async () => {
    // The single-file failure path with a non-Error rejection exercises the
    // `err instanceof Error ? err.message : 'Upload failed'` false arm.
    uploadAttachmentMock.mockImplementation(async () => {
      return Promise.reject('just a string');
    });
    const ref = { current: null as MessageInputHandle | null };
    const screen = await renderWithProviders(<MessageInput ref={ref} onSend={vi.fn()} />);
    await ref.current!.uploadFiles([new File(['x'], 'a.png', { type: 'image/png' })]);
    await expect.element(screen.getByText('Upload failed')).toBeVisible();
    await settle();
  });

  it('renders an image-preview chip with an object URL when an image file is uploaded', async () => {
    uploadAttachmentMock.mockImplementation(
      async (
        file: File,
        cb?: { onInit?: (i: { id: string; filename: string; contentType: string; size: number; alreadyExists: boolean; uploadURL: string }) => void; onProgress?: (f: number) => void },
      ) => {
        cb?.onInit?.({ id: `srv-${file.name}`, filename: file.name, contentType: 'image/png', size: file.size, alreadyExists: false, uploadURL: 'x' });
        cb?.onProgress?.(0.5);
        return { id: `srv-${file.name}`, filename: file.name, contentType: 'image/png', size: file.size, alreadyExists: false, uploadURL: 'x' };
      },
    );
    const ref = { current: null as MessageInputHandle | null };
    const screen = await renderWithProviders(<MessageInput ref={ref} onSend={vi.fn()} />);
    // An image file → the chip's localURL is created via URL.createObjectURL
    // (the isImageAttachment true arm in the optimistic chip).
    await ref.current!.uploadFiles([new File(['img-bytes'], 'photo.png', { type: 'image/png' })]);
    await expect.element(screen.getByLabelText('Draft attachments')).toBeVisible();
    const thumb = document.querySelector('[data-testid="attachment-chip-thumb"]') as HTMLImageElement | null;
    expect(thumb).not.toBeNull();
    expect(thumb!.src).toMatch(/^blob:/);
    await settle();
  });
});
