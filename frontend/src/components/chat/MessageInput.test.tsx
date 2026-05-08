import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput } from './MessageInput';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

// Stub the workspace-settings hook so MessageInput doesn't fire a
// real React Query against the mocked apiFetch — the late resolve
// would land outside act() and warn during focus-event tests.
vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false } }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
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

describe('MessageInput', () => {
  it('renders textarea and send button', () => {
    render(<MessageInput onSend={vi.fn()} />);

    expect(screen.getByLabelText('Message input')).toBeInTheDocument();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
  });

  it('send button is disabled when input is empty', () => {
    render(<MessageInput onSend={vi.fn()} />);

    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('send button is enabled when input has text', async () => {
    // jsdom doesn't accept synthetic typing into Lexical's
    // contenteditable; seed the body via initialBody to verify the
    // disabled-state wiring. `findByLabelText` flushes Lexical's
    // post-mount Placeholder state update inside act() — without it
    // we'd race against Placeholder's effect and surface an act()
    // warning.
    render(<MessageInput onSend={vi.fn()} initialBody="Hello" />);
    expect(await screen.findByLabelText('Send message')).not.toBeDisabled();
  });

  it('calls onSend when pressing Enter', async () => {
    // jsdom + contenteditable doesn't accept synthetic typing into
    // Tiptap, so seed via initialBody and just verify that Enter
    // routes through to onSend with the body.
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} initialBody="Hello" />);

    const editor = await screen.findByLabelText('Message input');
    editor.focus();
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalled();
    expect(onSend.mock.calls[0][0]).toEqual({ body: 'Hello', attachmentIDs: [] });
  });

  it('does not call onSend on Shift+Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'Hello{Shift>}{Enter}{/Shift}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('clears input after sending', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} initialBody="Hello" />);

    const editor = await screen.findByLabelText('Message input');
    editor.focus();
    await user.click(screen.getByLabelText('Send message'));

    expect(onSend).toHaveBeenCalled();
    await waitFor(() => {
      expect((editor.textContent ?? '').trim()).toBe('');
    });
  });

  it('blurs and returns to the single-line mobile composer after sending', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    setMobileMatch(true);
    render(<MessageInput onSend={onSend} initialBody="Hello" />);

    const editor = await screen.findByLabelText('Message input');
    act(() => {
      editor.focus();
    });
    await user.click(screen.getByLabelText('Send message'));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(onSend).toHaveBeenCalled();
    expect(document.activeElement).not.toBe(editor);
    expect(editor).toHaveClass('max-md:min-h-[1.5rem]', 'max-md:max-h-[1.5rem]');
    setMobileMatch(false);
  });

  it('does not send on bare Enter on mobile', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    setMobileMatch(true);
    render(<MessageInput onSend={onSend} initialBody="Hello" />);

    const editor = await screen.findByLabelText('Message input');
    act(() => {
      editor.focus();
    });
    await user.keyboard('{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    setMobileMatch(false);
  });

  it('moves the mobile send action into the formatting toolbar while focused', async () => {
    setMobileMatch(true);
    render(<MessageInput onSend={vi.fn()} initialBody="Hello" />);

    const editor = await screen.findByLabelText('Message input');
    act(() => {
      editor.focus();
    });

    const toolbar = await screen.findByRole('toolbar', { name: 'Formatting' });
    const send = within(toolbar).getByLabelText('Send message');
    expect(send).toHaveClass('h-7', 'w-7', 'max-md:h-9', 'max-md:w-9');
    expect(send.closest('[data-message-composer]')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Send message')).toHaveLength(1);
    setMobileMatch(false);
  });

  it('renders hydrated mobile image attachment thumbnails in the message box', async () => {
    setMobileMatch(true);
    render(
      <MessageInput
        onSend={vi.fn()}
        initialDrafts={[
          {
            id: 'att-1',
            filename: 'photo.png',
            contentType: 'image/png',
            size: 1234,
            url: 'https://cdn.example.test/photo.png',
            progress: 1,
          },
        ]}
      />,
    );

    const attachments = await screen.findByLabelText('Draft attachments');
    const thumb = within(attachments).getByTestId('attachment-chip-thumb');
    expect(thumb).toHaveAttribute('src', 'https://cdn.example.test/photo.png');
    expect(screen.getByTestId('attachment-chip')).toBeInTheDocument();
    setMobileMatch(false);
  });

  it('shows full mobile formatting controls for an attachment-only draft before focus', async () => {
    setMobileMatch(true);
    render(
      <MessageInput
        onSend={vi.fn()}
        initialDrafts={[
          {
            id: 'att-1',
            filename: 'photo.png',
            contentType: 'image/png',
            size: 1234,
            url: 'https://cdn.example.test/photo.png',
            progress: 1,
          },
        ]}
      />,
    );

    const editor = await screen.findByLabelText('Message input');
    expect(document.activeElement).not.toBe(editor);
    expect(editor).not.toHaveClass('max-md:min-h-[1.5rem]', 'max-md:max-h-[1.5rem]');

    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    expect(toolbar).toBeInTheDocument();
    expect(within(toolbar).getByLabelText('Bold (Ctrl+B)')).toBeInTheDocument();
    expect(within(toolbar).getByLabelText('Emoji')).toBeInTheDocument();
    expect(within(toolbar).getByLabelText('Send message')).toBeInTheDocument();
    expect(screen.getByLabelText('Draft attachments')).toBeInTheDocument();
    setMobileMatch(false);
  });

  it('minimizes the mobile bottom safe-area padding while the message box is focused', async () => {
    setMobileMatch(true);
    render(<MessageInput onSend={vi.fn()} />);

    const editor = await screen.findByLabelText('Message input');
    const composerShell = editor.closest('[data-composer-focused]')!;
    expect(composerShell).toHaveClass('max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]');

    act(() => {
      editor.focus();
    });

    await waitFor(() => expect(composerShell).toHaveAttribute('data-composer-focused', 'true'));
    expect(composerShell).toHaveClass('max-md:pb-2');
    expect(composerShell).not.toHaveClass('max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]');
    setMobileMatch(false);
  });

  it('moves the desktop send action into the formatting toolbar', async () => {
    setMobileMatch(false);
    render(<MessageInput onSend={vi.fn()} initialBody="Hello" />);

    const editor = await screen.findByLabelText('Message input');
    act(() => {
      editor.focus();
    });

    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    expect(within(toolbar).getByLabelText('Send message')).toBeInTheDocument();
    expect(screen.getByLabelText('Send message').closest('[role="toolbar"]')).toBe(toolbar);
    expect(screen.getAllByLabelText('Send message')).toHaveLength(1);
  });

  it('blurs and returns to single-line mobile composer after saving an edit', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    setMobileMatch(true);
    render(<MessageInput onSend={onSend} initialBody="Edited text" submitLabel="Save" />);

    const editor = await screen.findByLabelText('Message input');
    act(() => {
      editor.focus();
    });
    await user.click(screen.getByLabelText('Save'));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(onSend).toHaveBeenCalledWith({ body: 'Edited text', attachmentIDs: [] });
    expect(document.activeElement).not.toBe(editor);
    expect(editor).toHaveClass('max-md:min-h-[1.5rem]', 'max-md:max-h-[1.5rem]');
    setMobileMatch(false);
  });

  it('shows edit formatting controls immediately on mobile before focus', async () => {
    setMobileMatch(true);
    render(
      <MessageInput
        onSend={vi.fn()}
        onCancel={vi.fn()}
        initialBody="Edited text"
        submitLabel="Save"
      />,
    );

    const editor = await screen.findByLabelText('Message input');
    expect(document.activeElement).not.toBe(editor);
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    expect(toolbar).toBeInTheDocument();
    expect(screen.getByLabelText('Bold (Ctrl+B)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Code (Ctrl+E)')).not.toBeInTheDocument();
    expect(toolbar).toContainElement(screen.getByLabelText('Cancel'));
    const save = screen.getByLabelText('Save');
    expect(toolbar).toContainElement(save);
    expect(save).toHaveClass('h-7', 'w-7', 'max-md:h-9', 'max-md:w-9');
    expect(save).toHaveTextContent('');
    setMobileMatch(false);
  });

  it('cancels mobile composer editing when pressing outside the edit box', async () => {
    const onCancel = vi.fn();
    setMobileMatch(true);
    render(
      <div>
        <button type="button" data-testid="outside">Outside</button>
        <MessageInput
          onSend={vi.fn()}
          onCancel={onCancel}
          initialBody="Edited text"
          submitLabel="Save"
          cancelOnOutsidePointer
        />
      </div>,
    );

    const toolbar = await screen.findByRole('toolbar', { name: 'Formatting' });
    fireEvent.pointerDown(toolbar);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    setMobileMatch(false);
  });

  it('does not refocus the composer after saving an edit', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} initialBody="Edited text" submitLabel="Save" />);

    const editor = await screen.findByLabelText('Message input');
    editor.focus();
    await user.click(screen.getByLabelText('Save'));
    await flushMicrotasks();

    expect(onSend).toHaveBeenCalledWith({ body: 'Edited text', attachmentIDs: [] });
    expect(document.activeElement).not.toBe(editor);
  });

  it('does not rehydrate stale server draft text after the user clears the composer', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderTree = (initialBody: string) => (
      <QueryClientProvider client={qc}>
        <MessageInput onSend={vi.fn()} initialBody={initialBody} />
      </QueryClientProvider>
    );
    const { rerender } = rtlRender(renderTree('delete me'));
    const editor = await screen.findByLabelText('Message input');

    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    fireEvent.keyDown(editor, { key: 'Backspace' });

    await waitFor(() => {
      expect((editor.textContent ?? '').trim()).toBe('');
    });

    rerender(renderTree('delete me'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((editor.textContent ?? '').trim()).toBe('');
  });

  it('flushes a pending draft when the composer unmounts', async () => {
    const onDraftChange = vi.fn();
    const { unmount } = render(
      <MessageInput
        onSend={vi.fn()}
        initialBody="fast navigation draft"
        onDraftChange={onDraftChange}
      />,
    );
    await screen.findByLabelText('Message input');

    unmount();

    expect(onDraftChange).toHaveBeenCalledWith({
      body: 'fast navigation draft',
      attachmentIDs: [],
    });
  });

  it('flushes whitespace-only drafts without treating them as empty', async () => {
    const onDraftChange = vi.fn();
    const { unmount } = render(
      <MessageInput
        onSend={vi.fn()}
        initialBody={'  \n\n'}
        onDraftChange={onDraftChange}
      />,
    );
    await screen.findByLabelText('Message input');

    unmount();

    expect(onDraftChange).toHaveBeenCalledWith({
      body: '  \n\n',
      attachmentIDs: [],
    });
  });

  it('flushes the current draft immediately when the window loses focus', async () => {
    const onDraftChange = vi.fn();
    render(
      <MessageInput
        onSend={vi.fn()}
        initialBody="switching windows"
        onDraftChange={onDraftChange}
      />,
    );
    await screen.findByLabelText('Message input');

    window.dispatchEvent(new Event('blur'));

    expect(onDraftChange).toHaveBeenCalledWith({
      body: 'switching windows',
      attachmentIDs: [],
    });
  });

  it('flushes the previous draft to the previous focusKey scope before resetting the composer', async () => {
    const ch1DraftChange = vi.fn();
    const ch2DraftChange = vi.fn();
    const { rerender } = render(
      <MessageInput
        onSend={vi.fn()}
        focusKey="ch-1"
        initialBody="channel one draft"
        onDraftChange={ch1DraftChange}
      />,
    );
    await screen.findByLabelText('Message input');
    expect(ch1DraftChange).not.toHaveBeenCalled();

    await act(async () => {
      rerender(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MessageInput
            onSend={vi.fn()}
            focusKey="ch-2"
            initialBody=""
            onDraftChange={ch2DraftChange}
          />
        </QueryClientProvider>,
      );
      await flushMicrotasks();
    });

    expect(ch1DraftChange).toHaveBeenCalledWith({
      body: 'channel one draft',
      attachmentIDs: [],
    });
    expect(ch2DraftChange).not.toHaveBeenCalled();
  });

  it('does not run the view-switch draft flush when server draft props change under the same focusKey', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <MessageInput
        onSend={vi.fn()}
        focusKey="ch-1"
        initialBody=""
        onDraftChange={onDraftChange}
      />,
    );
    await screen.findByLabelText('Message input');

    await act(async () => {
      rerender(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MessageInput
            onSend={vi.fn()}
            focusKey="ch-1"
            initialBody="stale server draft"
            onDraftChange={onDraftChange}
          />
        </QueryClientProvider>,
      );
      await flushMicrotasks();
    });

    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it('does not move focus to the end when server draft props refresh under the same focusKey', async () => {
    const { rerender } = render(
      <MessageInput
        onSend={vi.fn()}
        focusKey="ch-1"
        initialBody="draft body"
      />,
    );
    const editor = await screen.findByLabelText('Message input');
    editor.blur();

    await act(async () => {
      rerender(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MessageInput
            onSend={vi.fn()}
            focusKey="ch-1"
            initialBody="draft body refreshed"
          />
        </QueryClientProvider>,
      );
      await flushMicrotasks();
    });

    expect(document.activeElement).not.toBe(editor);
  });

  it('hydrates an asynchronously loaded draft when no focusKey is provided', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderTree = (initialBody: string) => (
      <QueryClientProvider client={qc}>
        <MessageInput onSend={vi.fn()} initialBody={initialBody} />
      </QueryClientProvider>
    );
    const { rerender } = rtlRender(renderTree(''));
    const editor = await screen.findByLabelText('Message input');
    expect((editor.textContent ?? '').trim()).toBe('');

    await act(async () => {
      rerender(renderTree('draft loaded later'));
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect((editor.textContent ?? '').trim()).toBe('draft loaded later');
    });
  });

  it('uses custom placeholder', async () => {
    render(<MessageInput onSend={vi.fn()} placeholder="Write here..." />);
    // Lexical renders the placeholder as a sibling element of the
    // contenteditable when the doc is empty.
    await waitFor(() => {
      expect(screen.getByText('Write here...')).toBeInTheDocument();
    });
  });

  it('only disables send button (not textarea) when disabled prop is true', () => {
    render(<MessageInput onSend={vi.fn()} disabled />);

    // Textarea must remain enabled so user can keep typing
    expect(screen.getByLabelText('Message input')).not.toBeDisabled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('refocuses textarea after sending via Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} initialBody="hello" />);

    const textarea = await screen.findByLabelText('Message input');
    textarea.focus();
    await user.keyboard('{Enter}');

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it('refocuses textarea after sending via button click', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} initialBody="hello" />);

    const textarea = await screen.findByLabelText('Message input');
    await user.click(screen.getByLabelText('Send message'));

    expect(onSend).toHaveBeenCalledWith({ body: 'hello', attachmentIDs: [] });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it('dispatches ex:edit-message when ArrowUp is pressed in an empty composer', async () => {
    const user = userEvent.setup();
    const events: string[] = [];
    const listener = (e: Event) => {
      const ce = e as CustomEvent<{ messageId?: string }>;
      if (ce.detail?.messageId) events.push(ce.detail.messageId);
    };
    window.addEventListener('ex:edit-message', listener);
    render(<MessageInput onSend={vi.fn()} lastOwnMessageId="msg-7" />);
    const editor = await screen.findByLabelText('Message input');
    editor.focus();
    await user.keyboard('{ArrowUp}');
    window.removeEventListener('ex:edit-message', listener);
    expect(events).toEqual(['msg-7']);
  });

  it('does NOT dispatch ex:edit-message when the composer has content', async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener('ex:edit-message', listener);
    render(
      <MessageInput onSend={vi.fn()} lastOwnMessageId="msg-7" initialBody="draft" />,
    );
    const editor = await screen.findByLabelText('Message input');
    editor.focus();
    await user.keyboard('{ArrowUp}');
    window.removeEventListener('ex:edit-message', listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does NOT dispatch ex:edit-message when there is no candidate own message', async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener('ex:edit-message', listener);
    render(<MessageInput onSend={vi.fn()} />);
    const editor = await screen.findByLabelText('Message input');
    editor.focus();
    await user.keyboard('{ArrowUp}');
    window.removeEventListener('ex:edit-message', listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('shows attachment-only mobile drafts as a full composer with upload progress before focus', async () => {
    setMobileMatch(true);
    render(
      <MessageInput
        onSend={vi.fn()}
        initialDrafts={[
          {
            id: 'att-uploading-1',
            filename: 'photo.png',
            contentType: 'image/png',
            size: 2048,
            localURL: 'blob:uploading-photo',
            progress: 0.42,
          },
        ]}
      />,
    );

    expect(await screen.findByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    expect(screen.getByLabelText('Draft attachments')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Uploading photo.png' })).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByLabelText('Attach file')).toBeInTheDocument();
  });

  it('can hide the code toolbar button for constrained composers', async () => {
    render(<MessageInput onSend={vi.fn()} initialBody="hello" hideCodeButton />);

    expect(await screen.findByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Code (Ctrl+E)')).not.toBeInTheDocument();
  });

  it('refocuses on ex:focus-composer when parent + scope match (main composer)', async () => {
    render(
      <MessageInput
        onSend={vi.fn()}
        typingParentID="ch-1"
        typingParentType="channel"
      />,
    );
    const editor = await screen.findByLabelText('Message input');
    editor.blur();
    expect(document.activeElement).not.toBe(editor);
    window.dispatchEvent(
      new CustomEvent('ex:focus-composer', {
        detail: { parentID: 'ch-1', inThread: false },
      }),
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(editor);
    });
  });

  it('does NOT refocus when ex:focus-composer comes from a different parent', async () => {
    render(
      <MessageInput
        onSend={vi.fn()}
        typingParentID="ch-1"
        typingParentType="channel"
      />,
    );
    const editor = await screen.findByLabelText('Message input');
    editor.blur();
    window.dispatchEvent(
      new CustomEvent('ex:focus-composer', {
        detail: { parentID: 'ch-2', inThread: false },
      }),
    );
    // Give the queueMicrotask a tick to reveal a buggy fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).not.toBe(editor);
  });

  it('thread composer ignores main-scope ex:focus-composer events', async () => {
    render(
      <MessageInput
        onSend={vi.fn()}
        typingParentID="ch-1"
        typingParentType="channel"
        typingThreadRootID="root-1"
      />,
    );
    const editor = await screen.findByLabelText('Message input');
    editor.blur();
    window.dispatchEvent(
      new CustomEvent('ex:focus-composer', {
        detail: { parentID: 'ch-1', inThread: false },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).not.toBe(editor);
  });
});
