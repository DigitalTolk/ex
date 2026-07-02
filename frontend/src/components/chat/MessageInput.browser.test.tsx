import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { expectPaintedAtCenter } from '@/test/browser-assertions';
import { setWSSender } from '@/lib/ws-sender';
import { dispatchFocusComposer } from '@/lib/window-events';

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
  useDeleteDraftAttachment: () => ({ mutateAsync: deleteDraftMock, mutate: vi.fn(), isPending: false }),
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
    // The padded, background-bearing root is the docked composer's outer
    // wrapper (the one carrying `data-composer-focused`). The composer box is
    // nested inside an extra `relative` wrapper that anchors the typing
    // indicator, so walk by attribute rather than a fixed parentElement hop.
    const root = composer!.closest('[data-composer-focused]') as HTMLElement;

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
      // Desktop composer is rounded-2xl (16px) per spec — rounder than the
      // old rounded-lg, but still well short of the mobile pill (≥24).
      expect(radius).toBeGreaterThanOrEqual(14);
      expect(radius).toBeLessThanOrEqual(18);
      // Spec border width is 2px (the screenshot measured #E9E9E9 over 2px),
      // not the default 1px.
      expect(Number.parseFloat(getComputedStyle(composer!).borderTopWidth)).toBeGreaterThanOrEqual(2);
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

  it('drops the safe-area inset when bottomInset is false (in-list composers like /threads cards)', async () => {
    if (window.innerWidth > 767) return;
    // An in-list composer (e.g. the /threads ThreadCards) is not docked at
    // the viewport bottom, so it must NOT reserve home-indicator space —
    // that inset just left a dead ~34px gap below it.
    await renderWithProviders(<MessageInput onSend={vi.fn()} bottomInset={false} />);
    const composerShell = document.querySelector('[data-composer-focused]') as HTMLElement | null;
    expect(composerShell).not.toBeNull();
    // Idle + bottomInset=false → tight 4px padding, no safe-area inset.
    expect(Number.parseFloat(getComputedStyle(composerShell!).paddingBottom)).toBeLessThanOrEqual(6);
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

  // NB: the old Lexical "mention-popup" positioning test was removed in the CM6
  // cutover — CodeMirror's autocomplete tooltip owns its own in-viewport
  // placement, and the mention autocomplete behaviour is covered by the
  // markdown extension suites (completions / mentionAutocomplete / MarkdownEditor).

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
    }, { timeout: 5000 });
    // The refocus chain (pick → insert → re-render → editor.focus()) runs in
    // its own deferred ticks and can lag well behind the portal teardown under
    // full-suite CPU load on the mobile WebKit project — give it a separate,
    // generous window so a slow refocus doesn't fail alongside the (already
    // satisfied) portal-closed check.
    await vi.waitFor(() => {
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
    }, { timeout: 20000 });
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
    // Poll the computed color — under a heavy full browser run the theme CSS
    // can resolve a tick after render, which flaked a synchronous read.
    await vi.waitFor(() => {
      const rgb = parseRGB(getComputedStyle(send).backgroundColor);
      expect(rgb).not.toBeNull();
      // Near-black (#231F20 → rgb(35,31,32))
      expect(rgb![0]).toBeLessThan(60);
      expect(rgb![1]).toBeLessThan(60);
      expect(rgb![2]).toBeLessThan(60);
    });
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
      await vi.waitFor(() => {
        const rgb = parseRGB(getComputedStyle(send).backgroundColor);
        expect(rgb).not.toBeNull();
        // Brand pink (#DE5D83 → rgb(222,93,131))
        expect(rgb![0]).toBeGreaterThan(180);
        expect(rgb![1]).toBeLessThan(140);
        expect(rgb![2]).toBeGreaterThan(90);
      });
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('sends the composed body when the send button is clicked', async () => {
    const onSend = vi.fn();
    const screen = await renderWithProviders(
      <MessageInput onSend={onSend} initialBody="hello world" />,
    );
    await screen.getByRole('button', { name: 'Send message' }).click();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toMatchObject({ body: 'hello world', attachmentIDs: [] });
  });

  it('disables the send button when the composer is empty', async () => {
    const onSend = vi.fn();
    const screen = await renderWithProviders(<MessageInput onSend={onSend} />);
    const send = screen.getByRole('button', { name: 'Send message' }).element() as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it('renders Cancel and a labeled save action in edit mode, and Cancel fires onCancel', async () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    const screen = await renderWithProviders(
      <MessageInput onSend={onSend} onCancel={onCancel} submitLabel="Save changes" initialBody="edit me" />,
    );
    // Edit mode renders a Cancel button plus a save button labeled by submitLabel.
    await expect.element(screen.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await screen.getByRole('button', { name: 'Cancel' }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('submits the edit through the labeled save action', async () => {
    const onSend = vi.fn();
    const screen = await renderWithProviders(
      <MessageInput onSend={onSend} onCancel={vi.fn()} submitLabel="Save changes" initialBody="edited body" />,
    );
    await screen.getByRole('button', { name: 'Save changes' }).click();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toMatchObject({ body: 'edited body' });
  });

  it('renders draft attachment chips supplied via initialDrafts', async () => {
    const drafts = [
      { id: 'att-1', filename: 'a.png', contentType: 'image/png', size: 100 },
      { id: 'att-2', filename: 'b.png', contentType: 'image/png', size: 100 },
    ];
    await renderWithProviders(<MessageInput onSend={vi.fn()} initialDrafts={drafts} />);
    expect(document.querySelector('[aria-label="Draft attachments"]')).not.toBeNull();
  });

  it('warns and disables sending when attachments exceed the per-message limit', async () => {
    const drafts = Array.from({ length: 11 }, (_, i) => ({
      id: `att-${i}`, filename: `f${i}.png`, contentType: 'image/png', size: 100,
    }));
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialDrafts={drafts} />);
    await expect.element(screen.getByTestId('message-attachments-too-many')).toBeVisible();
    const send = screen.getByRole('button', { name: 'Send message' }).element() as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});

// Desktop-only flow coverage: the link dialog, typing emit, ArrowUp edit,
// draft-change debounce/flush, attachment removal error handling, the GIF
// picker, and the upload pool's success / partial-failure paths. These run on
// the desktop project (the mobile compact composer hides the link button and
// some of these surfaces); they bail early on narrow viewports.
describe('MessageInput desktop flows (browser)', () => {
  beforeEach(() => {
    deleteDraftMock.mockReset();
    deleteDraftMock.mockResolvedValue(undefined);
    setWSSender(null);
  });
  // Let Lexical's async update listeners (the typeahead setQuery / onChange
  // microtasks) drain before the test ends so their state updates resolve
  // inside the test window instead of leaking into the next test's act gate.
  async function settle() {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  afterEach(async () => {
    setWSSender(null);
    cleanup();
    // Drain any trailing Lexical/typeahead state updates so their act
    // warnings resolve inside this test's window — this afterEach is
    // registered after the console-gate's, so it runs *before* the gate
    // assertion (afterEach hooks run in reverse registration order).
    await settle();
  });

  async function typeInComposer(screen: ReturnType<typeof renderWithProviders>, text: string) {
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill(text);
    await settle();
  }

  it('opens the link dialog, blocks unsafe URLs, and commits an http link', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody="anchor text" />);

    await screen.getByLabelText('Link').click();
    const dialog = screen.getByLabelText('Insert link');
    await expect.element(dialog).toBeVisible();

    const urlInput = screen.getByLabelText('URL').element() as HTMLInputElement;
    const insert = screen.getByRole('button', { name: 'Insert' }).element() as HTMLButtonElement;
    // Empty URL → Insert disabled (isHttpUrl gate).
    expect(insert.disabled).toBe(true);

    // A javascript: scheme passes the <input type=url> but is rejected by
    // isHttpUrl — Insert stays disabled.
    await userEvent.fill(urlInput, 'javascript:alert(1)');
    expect(insert.disabled).toBe(true);

    // A real http(s) URL enables Insert; submitting closes the dialog.
    await userEvent.fill(urlInput, 'https://example.com');
    await vi.waitFor(() => expect(insert.disabled).toBe(false));
    await insert.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Insert link"]')).toBeNull();
    });
  });

  it('cancels the link dialog without committing', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} initialBody="x" />);
    await screen.getByLabelText('Link').click();
    await expect.element(screen.getByLabelText('Insert link')).toBeVisible();
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Insert link"]')).toBeNull();
    });
  });

  it('emits throttled typing frames over the websocket while composing', async () => {
    if (window.innerWidth <= 767) return;
    const frames: string[] = [];
    setWSSender((f) => frames.push(f));
    const screen = await renderWithProviders(
      <MessageInput
        onSend={vi.fn()}
        typingParentID="ch-1"
        typingParentType="channel"
        typingThreadRootID="msg-root"
      />,
    );
    await typeInComposer(screen, 'hello');
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThanOrEqual(1);
    });
    const frame = JSON.parse(frames[0]);
    expect(frame).toMatchObject({
      type: 'typing',
      parentID: 'ch-1',
      parentType: 'channel',
      parentMessageID: 'msg-root',
    });
    // Throttled: a burst of keystrokes within 3s does not flood the socket.
    expect(frames.length).toBeLessThan(5);
  });

  it('does not emit typing frames when no typing parent is configured', async () => {
    if (window.innerWidth <= 767) return;
    const frames: string[] = [];
    setWSSender((f) => frames.push(f));
    const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
    await typeInComposer(screen, 'hi');
    // emitTyping returns early without a typingParentID/Type.
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.length).toBe(0);
  });

  it('dispatches an edit-last request on ArrowUp in an empty composer', async () => {
    if (window.innerWidth <= 767) return;
    const seen: string[] = [];
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ messageId: string }>).detail?.messageId;
      if (id) seen.push(id);
    };
    window.addEventListener('ex:edit-message', handler);
    try {
      const screen = await renderWithProviders(
        <MessageInput onSend={vi.fn()} lastOwnMessageId="msg-9" />,
      );
      const editor = screen.getByLabelText('Message input');
      await editor.click();
      await userEvent.keyboard('{ArrowUp}');
      await vi.waitFor(() => {
        expect(seen).toContain('msg-9');
      });
      await settle();
    } finally {
      window.removeEventListener('ex:edit-message', handler);
    }
  });

  it('debounces draft changes and flushes the latest draft on window blur', async () => {
    if (window.innerWidth <= 767) return;
    const onDraftChange = vi.fn();
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} focusKey="ch-1" onDraftChange={onDraftChange} />,
    );
    await typeInComposer(screen, 'draft body');
    // The 600ms debounce eventually fires onDraftChange with the typed body.
    await vi.waitFor(() => {
      expect(onDraftChange).toHaveBeenCalled();
      const last = onDraftChange.mock.calls.at(-1)![0];
      expect(last.body).toContain('draft');
    }, { timeout: 2000 });

    // A window blur flushes immediately via flushDraft.
    onDraftChange.mockClear();
    window.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => {
      expect(onDraftChange).toHaveBeenCalled();
    });
    await settle();
  });

  it('refocuses the composer on a matching focus-composer event', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await renderWithProviders(
      <MessageInput onSend={vi.fn()} typingParentID="ch-7" typingParentType="channel" />,
    );
    const editor = screen.getByLabelText('Message input').element() as HTMLElement;
    editor.blur();
    dispatchFocusComposer({ parentID: 'ch-7', inThread: false });
    await vi.waitFor(() => {
      expect(document.activeElement === editor || editor.contains(document.activeElement)).toBe(true);
    });
    await settle();
  });

  it('removes a draft attachment and swallows a 409 conflict from the server', async () => {
    const { ApiError } = await import('@/lib/api');
    deleteDraftMock.mockRejectedValueOnce(new ApiError(409, 'still referenced'));
    const screen = await renderWithProviders(
      <MessageInput
        onSend={vi.fn()}
        initialDrafts={[{ id: 'att-x', filename: 'a.png', contentType: 'image/png', size: 10 }]}
      />,
    );
    await expect.element(screen.getByLabelText('Draft attachments')).toBeVisible();
    await screen.getByRole('button', { name: /Remove/ }).click();
    await vi.waitFor(() => {
      expect(deleteDraftMock).toHaveBeenCalledWith('att-x');
    });
    // The chip is gone and no error rail surfaced (409 is swallowed).
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Draft attachments"]')).toBeNull();
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('surfaces a non-409 error when removing a draft attachment fails', async () => {
    deleteDraftMock.mockRejectedValueOnce(new Error('network down'));
    const screen = await renderWithProviders(
      <MessageInput
        onSend={vi.fn()}
        initialDrafts={[{ id: 'att-y', filename: 'b.png', contentType: 'image/png', size: 10 }]}
      />,
    );
    await screen.getByRole('button', { name: /Remove/ }).click();
    await expect.element(screen.getByText('network down')).toBeVisible();
  });

  it('uploads files through the imperative handle, capping at the per-message limit', async () => {
    uploadAttachmentMock.mockImplementation(
      async (
        file: File,
        cb?: { onInit?: (i: { id: string; filename: string; contentType: string; size: number; alreadyExists: boolean; uploadURL: string }) => void; onProgress?: (f: number) => void },
      ) => {
        cb?.onInit?.({ id: `srv-${file.name}`, filename: file.name, contentType: file.type || 'application/octet-stream', size: file.size, alreadyExists: true, uploadURL: 'x' });
        cb?.onProgress?.(1);
        return { id: `srv-${file.name}`, filename: file.name, contentType: 'application/octet-stream', size: file.size, alreadyExists: true, uploadURL: 'x' };
      },
    );
    const ref = { current: null as MessageInputHandle | null };
    const screen = await renderWithProviders(
      <MessageInput ref={ref} onSend={vi.fn()} />,
    );
    // Drive the imperative uploadFiles entrypoint with more than the cap (11
    // files > 10) so the over-limit warning + slice path both run.
    const files = Array.from({ length: 11 }, (_, i) => new File([`b${i}`], `f${i}.png`, { type: 'image/png' }));
    await ref.current!.uploadFiles(files);
    await expect.element(screen.getByLabelText('Draft attachments')).toBeVisible();
    // The over-limit warning rail mentions the skipped overflow.
    await expect.element(screen.getByText(/Skipped/)).toBeVisible();
    uploadAttachmentMock.mockReset();
  });

  it('reports a per-file upload failure without dropping the surviving chips', async () => {
    uploadAttachmentMock.mockImplementation(
      async (
        file: File,
        cb?: { onInit?: (i: { id: string; filename: string; contentType: string; size: number; alreadyExists: boolean; uploadURL: string }) => void; onProgress?: (f: number) => void },
      ) => {
        if (file.name === 'bad.png') throw new Error('upload exploded');
        cb?.onInit?.({ id: `srv-${file.name}`, filename: file.name, contentType: file.type, size: file.size, alreadyExists: true, uploadURL: 'x' });
        cb?.onProgress?.(1);
        return { id: `srv-${file.name}`, filename: file.name, contentType: file.type, size: file.size, alreadyExists: true, uploadURL: 'x' };
      },
    );
    const ref = { current: null as MessageInputHandle | null };
    const screen = await renderWithProviders(<MessageInput ref={ref} onSend={vi.fn()} />);
    await ref.current!.uploadFiles([
      new File(['ok'], 'good.png', { type: 'image/png' }),
      new File(['x'], 'bad.png', { type: 'image/png' }),
    ]);
    // The failure surfaces on the error rail; the good chip survives.
    await expect.element(screen.getByText('upload exploded')).toBeVisible();
    await expect.element(screen.getByLabelText('Draft attachments')).toBeVisible();
    uploadAttachmentMock.mockReset();
  });

  it('renders the GIF picker trigger when GIPHY is enabled', async () => {
    // The GiphyPicker (and thus the `giphyEnabled &&` branch) only renders
    // when both the flag and an API key are present.
    settingsState.current = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: true, giphyAPIKey: 'gk-test' };
    try {
      const screen = await renderWithProviders(<MessageInput onSend={vi.fn()} />);
      if (window.innerWidth <= 767) {
        // Mobile compact composer hides the toolbar until focused.
        await screen.getByLabelText('Message input').click();
      }
      await expect.element(screen.getByLabelText('GIF')).toBeVisible();
    } finally {
      settingsState.current = { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false, giphyAPIKey: '' };
    }
  });
});

// Server-backed frequently-used shelf: stub so opening the picker never hits the network.
vi.mock('@/lib/emoji-frequency', () => ({
  EMOJI_FREQUENCY_CHANGED_EVENT: 'emoji-frequency-changed',
  getFrequentEmojis: vi.fn(async () => []),
  recordEmojiUse: vi.fn(async () => {}),
}));
