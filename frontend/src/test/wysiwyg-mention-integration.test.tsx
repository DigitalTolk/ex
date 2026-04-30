import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/chat/WysiwygEditor';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function renderEditor(initialBody = '', onChange = vi.fn()) {
  const ref = createRef<WysiwygEditorHandle>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <WysiwygEditor ref={ref} initialBody={initialBody} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { ref, ...utils };
}

// Place a collapsed selection at the end of the given text node.
function placeCaretAtEnd(node: Node, offset?: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  const end = offset ?? (node.textContent?.length ?? 0);
  r.setStart(node, end);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Simulate the user typing into the contentEditable: appends a string to
// the first text node and fires onInput. jsdom doesn't synthesise the
// native typing flow, so we mutate then dispatch.
function typeInto(editor: HTMLElement, text: string) {
  // Ensure there's a text node to land in.
  if (!editor.firstChild) {
    editor.appendChild(document.createTextNode(''));
  }
  let textNode: Text | null = null;
  for (const c of Array.from(editor.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) {
      textNode = c as Text;
      break;
    }
  }
  if (!textNode) {
    textNode = document.createTextNode('');
    editor.appendChild(textNode);
  }
  textNode.data = (textNode.data ?? '') + text;
  placeCaretAtEnd(textNode);
  fireEvent.input(editor);
}

describe('WysiwygEditor — mention integration', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    // Default: any /api/v1/users fetch (mention popup roster, search,
    // etc.) returns a small roster. Per-test calls to mockResolvedValue*
    // override this for specific assertions.
    apiFetchMock.mockImplementation((url: unknown) => {
      if (typeof url === 'string' && url.startsWith('/api/v1/users')) {
        return Promise.resolve([
          { id: 'u-1', email: 'alice@example.com', displayName: 'Alice' },
          { id: 'u-2', email: 'bob@example.com', displayName: 'Bob' },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  it('opens the mention popover when the user types @', async () => {
    renderEditor();
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, '@');
    });
    await waitFor(() => {
      expect(screen.getByTestId('mention-popup')).toBeInTheDocument();
    });
  });

  it('suppresses the popover when @ is in the middle of a word (email-like)', () => {
    renderEditor();
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, 'user@all');
    });
    expect(screen.queryByTestId('mention-popup')).toBeNull();
  });

  it('closes the popover when whitespace appears in the query', async () => {
    renderEditor();
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, '@al');
    });
    await waitFor(() => expect(screen.getByTestId('mention-popup')).toBeInTheDocument());
    act(() => {
      typeInto(editor, ' done');
    });
    expect(screen.queryByTestId('mention-popup')).toBeNull();
  });

  it('inserts a group mention as plain text (@here) and closes the popover', async () => {
    const onChange = vi.fn();
    renderEditor('', onChange);
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, '@here');
    });
    await waitFor(() => expect(screen.getByTestId('mention-popup')).toBeInTheDocument());

    // ArrowDown → highlights @here (groups: @all=0, @here=1).
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(screen.queryByTestId('mention-popup')).toBeNull();
    // Editor text now contains @here followed by a space.
    expect(editor.textContent).toContain('@here ');
    // onChange was emitted with the markdown.
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall).toContain('@here');
  });

  it('inserts a user mention as a contenteditable=false pill', async () => {
    apiFetchMock.mockResolvedValueOnce([
      { id: 'u-1', email: 'a@x.com', displayName: 'Alice' },
    ]);
    const onChange = vi.fn();
    renderEditor('', onChange);
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, '@al');
    });

    // Wait for Alice's row to appear in the suggestion list. User
    // rows in the new mention popup show the bare display name (the
    // avatar identifies them as a user); only @all/@here have a
    // leading @ in the row label.
    let aliceOpt: HTMLElement | undefined;
    await waitFor(() => {
      const opts = screen.getAllByTestId('mention-option');
      aliceOpt = opts.find((o) => o.textContent?.includes('Alice'));
      expect(aliceOpt).toBeDefined();
    });

    // Click the Alice row directly — mouseDown is what the popover listens
    // for (the click handler uses preventDefault + onMouseDown to avoid
    // contentEditable losing focus).
    fireEvent.mouseDown(aliceOpt!);

    expect(screen.queryByTestId('mention-popup')).toBeNull();
    const span = editor.querySelector('span.mention');
    expect(span).not.toBeNull();
    expect(span?.getAttribute('data-user-id')).toBe('u-1');
    expect(span?.getAttribute('contenteditable')).toBe('false');
    expect(span?.textContent).toBe('@Alice');
  });

  it('mentionState swallows Enter so the editor does not submit while picking', async () => {
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WysiwygEditor ref={ref} onSubmit={onSubmit} />
      </QueryClientProvider>,
    );
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, '@al');
    });
    await waitFor(() => expect(screen.getByTestId('mention-popup')).toBeInTheDocument());
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blur closes the popover', async () => {
    renderEditor();
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, '@al');
    });
    await waitFor(() => expect(screen.getByTestId('mention-popup')).toBeInTheDocument());
    fireEvent.blur(editor);
    expect(screen.queryByTestId('mention-popup')).toBeNull();
  });

  it('hydrates an initial body with @[id|name] into a mention pill', () => {
    renderEditor('hi @[u-9|Bob]');
    const editor = screen.getByLabelText('Message input');
    const span = editor.querySelector('span.mention');
    expect(span?.getAttribute('data-user-id')).toBe('u-9');
    expect(span?.textContent).toBe('@Bob');
  });

  it('opens the channel popover when the user types ~', async () => {
    apiFetchMock.mockResolvedValue([
      { id: 'c1', slug: 'general', name: 'general', type: 'public', archived: false },
    ]);
    renderEditor();
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, '~');
    });
    await waitFor(() => expect(screen.getByTestId('channel-popup')).toBeInTheDocument());
  });

  it('inserts a channel mention as a contenteditable=false pill on Enter', async () => {
    apiFetchMock.mockResolvedValue([
      { id: 'c1', slug: 'general', name: 'general', type: 'public', archived: false },
    ]);
    const onChange = vi.fn();
    renderEditor('', onChange);
    const editor = screen.getByLabelText('Message input');
    act(() => {
      typeInto(editor, '~gen');
    });
    await waitFor(() => expect(screen.getByTestId('channel-popup')).toBeInTheDocument());

    fireEvent.keyDown(window, { key: 'Enter' });

    const span = editor.querySelector('span.channel-mention');
    expect(span?.getAttribute('data-channel-id')).toBe('c1');
    expect(span?.textContent).toBe('~general');
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall).toContain('~[c1|general]');
  });

  it('hydrates an initial body with ~[id|slug] into a channel pill', () => {
    renderEditor('check ~[c-1|general]');
    const editor = screen.getByLabelText('Message input');
    const span = editor.querySelector('span.channel-mention');
    expect(span?.getAttribute('data-channel-id')).toBe('c-1');
    expect(span?.textContent).toBe('~general');
  });
});
