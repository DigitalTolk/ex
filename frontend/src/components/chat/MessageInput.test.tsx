import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
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
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalled();
    await waitFor(() => {
      expect((editor.textContent ?? '').trim()).toBe('');
    });
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

  it('flushes the previous draft before a focusKey view switch resets the composer', async () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <MessageInput
        onSend={vi.fn()}
        focusKey="ch-1"
        initialBody="channel one draft"
        onDraftChange={onDraftChange}
      />,
    );
    await screen.findByLabelText('Message input');
    expect(onDraftChange).not.toHaveBeenCalled();

    await act(async () => {
      rerender(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MessageInput
            onSend={vi.fn()}
            focusKey="ch-2"
            initialBody=""
            onDraftChange={onDraftChange}
          />
        </QueryClientProvider>,
      );
      await flushMicrotasks();
    });

    expect(onDraftChange).toHaveBeenCalledWith({
      body: 'channel one draft',
      attachmentIDs: [],
    });
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
