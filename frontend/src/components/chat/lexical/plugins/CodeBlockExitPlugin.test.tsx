import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';
import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/chat/WysiwygEditor';
import { makeDataTransfer } from '@/test/dataTransfer';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));
vi.mock('@/hooks/useConversations', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useConversations')>('@/hooks/useConversations');
  return { ...actual, useAllUsers: () => ({ data: [] }) };
});
vi.mock('@/hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useChannels')>('@/hooks/useChannels');
  return { ...actual, useUserChannels: () => ({ data: [] }) };
});
vi.mock('@/hooks/useEmoji', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useEmoji')>('@/hooks/useEmoji');
  return { ...actual, useEmojis: () => ({ data: [] }) };
});
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>() }),
}));

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('CodeBlockExitPlugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('Enter inside a code block does NOT submit', async () => {
    // Inside a fenced code block, Enter must insert a newline rather
    // than submitting. SubmitOnEnterPlugin already short-circuits when
    // the caret is inside a $isCodeNode, so this test guards against
    // that wiring regressing.
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} initialBody={'```\nhello'} onSubmit={onSubmit} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    // Confirm the <code> block actually rendered before pressing Enter.
    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).not.toBeNull();
    });
    // Seed a Lexical range selection at end-of-doc so the SubmitOnEnter
    // handler can walk parents and detect $isCodeNode (without this,
    // jsdom has no DOM selection and the handler falls through to
    // top-level submit).
    act(() => {
      ref.current!.insertText('');
    });
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('typing the closing ``` + Enter exits the code block into a paragraph', async () => {
    // The exit behavior: caret inside a code block whose current line
    // is exactly "```" — pressing Enter strips the fence and drops a
    // paragraph after the code node so the user can keep typing in
    // plain text. Mirrors the Slack / GitHub markdown UX.
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} initialBody={'```\nfoo\n```'} onSubmit={onSubmit} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).not.toBeNull();
    });
    // insertText('') seeds a Lexical range selection at end-of-doc —
    // the caret lands inside the closing "```" line of the code block,
    // which is exactly the state we need to test.
    act(() => {
      ref.current!.insertText('');
    });
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    // After exit, a fresh paragraph follows the code block and the
    // closing fence has been stripped from the code node.
    await waitFor(() => {
      const root = ref.current!.getElement();
      const code = root?.querySelector('code');
      expect(code?.textContent ?? '').not.toContain('```');
    });
  });

  it('turns an opening fence into a code block on Shift+Enter', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    const editor = screen.getByLabelText('Message input');

    act(() => ref.current!.insertText('```'));
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    await waitFor(() => {
      const code = ref.current!.getElement()?.querySelector('code');
      expect(code).not.toBeNull();
    });
  });

  it.each(['ts', 'python', 'go', 'rust', 'bash', 'ini', 'hcl', 'c++', 'c#'])(
    'keeps the %s language when an opening fence converts on Shift+Enter',
    async (language) => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    const editor = screen.getByLabelText('Message input');

    act(() => ref.current!.insertText(`\`\`\`${language}`));
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).not.toBeNull();
    });
    expect(ref.current!.getMarkdown()).toContain(`\`\`\`${language}`);
    },
  );

  it('turns a soft-line opening fence into a code block on Shift+Enter', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    const editor = screen.getByLabelText('Message input');

    act(() => ref.current!.insertText('before'));
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    act(() => ref.current!.insertText('```'));
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      const root = ref.current!.getElement();
      expect(root?.textContent).toContain('before');
      expect(root?.querySelector('code')).not.toBeNull();
    });
  });

  it('leaves non-fence Shift+Enter text alone', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    const editor = screen.getByLabelText('Message input');

    act(() => ref.current!.insertText('not a fence'));
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      const root = ref.current!.getElement();
      expect(root?.querySelector('code')).toBeNull();
      expect(root?.textContent).toContain('not a fence');
    });
  });

  it('pastes fenced markdown with internal lines as a code block', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: makeDataTransfer({
        text: '```\nfoo\nbar\n```',
        types: ['text/plain'],
      }),
    });

    await waitFor(() => {
      const code = ref.current!.getElement()?.querySelector('code');
      expect(code?.querySelectorAll('br')).toHaveLength(1);
      expect(code?.textContent).toBe('foobar');
    });
    expect(ref.current!.getMarkdown()).toContain('foo\nbar');
  });

  it('pastes fenced markdown as a code block', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: makeDataTransfer({
        text: '```\nAdaasdas\n```',
        types: ['text/plain'],
      }),
    });

    await waitFor(() => {
      const code = ref.current!.getElement()?.querySelector('code');
      expect(code?.textContent).toBe('Adaasdas');
    });
    expect(ref.current!.getMarkdown()).toContain('Adaasdas');
  });

  it('pastes an empty fenced block as an empty code block', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: makeDataTransfer({
        text: '```\n```',
        types: ['text/plain'],
      }),
    });

    await waitFor(() => {
      const code = ref.current!.getElement()?.querySelector('code');
      expect(code).not.toBeNull();
      expect(code?.textContent).toBe('');
    });
  });

  it('does not treat plain pasted text as a fenced code block', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: makeDataTransfer({
        text: 'Adaasdas',
        types: ['text/plain'],
      }),
    });

    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).toBeNull();
    });
  });

  it('pastes a fenced code block into existing text without dropping the text', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    act(() => ref.current!.insertText('before'));
    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: makeDataTransfer({
        text: '```js\nconst x = 1\n```',
        types: ['text/plain'],
      }),
    });

    await waitFor(() => {
      const root = ref.current!.getElement();
      expect(root?.textContent).toContain('before');
      expect(root?.querySelector('code')?.textContent).toBe('const x = 1');
    });
    expect(ref.current!.getMarkdown()).toContain('```js');
  });

  it.each(['php', 'javascript', 'bash', 'ini', 'hcl', 'c++', 'c#'])(
    'keeps %s language hints when pasting fenced markdown',
    async (language) => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    fireEvent.paste(screen.getByLabelText('Message input'), {
      clipboardData: makeDataTransfer({
        text: `\`\`\`${language}\nvalue = 1;\n\`\`\``,
        types: ['text/plain'],
      }),
    });

    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')?.textContent).toBe('value = 1;');
    });
    expect(ref.current!.getMarkdown()).toContain(`\`\`\`${language}`);
    },
  );

  it('ArrowDown at the last line of a code block exits to a paragraph', async () => {
    // Slack/GitHub UX: ↓ at the bottom of a fenced block escapes to a
    // fresh paragraph below so users don't have to type the closing
    // fence. ArrowDown above the last line stays inside the code.
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} initialBody={'```\nfoo\nbar'} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).not.toBeNull();
    });
    act(() => {
      ref.current!.insertText('');
    });
    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'ArrowDown' });
    await waitFor(() => {
      // After exit, a paragraph follows the code block.
      const root = ref.current!.getElement();
      expect(root?.querySelector('code + p, pre + p')).not.toBeNull();
    });
  });

  it('ArrowDown in an empty code block removes the code shell', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} initialBody={'```\n```'} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).not.toBeNull();
    });
    act(() => {
      ref.current!.insertText('');
    });

    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'ArrowDown' });

    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).toBeNull();
    });
    expect(ref.current!.getMarkdown()).toBe('');
  });

  it('closing fence in an empty code block removes the code shell', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} initialBody={'```\n```'} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).not.toBeNull();
    });
    act(() => {
      ref.current!.insertText('```');
    });

    fireEvent.keyDown(screen.getByLabelText('Message input'), { key: 'Enter' });

    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).toBeNull();
    });
    expect(ref.current!.getMarkdown()).toBe('');
  });

  it('round-trips a fenced code block back to ``` markdown', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(
      <Providers>
        <WysiwygEditor ref={ref} initialBody={'```\nfoo\nbar\n```'} />
      </Providers>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => {
      expect(ref.current!.getElement()?.querySelector('code')).not.toBeNull();
    });
    const md = ref.current!.getMarkdown();
    expect(md).toContain('```');
    expect(md).toContain('foo');
    expect(md).toContain('bar');
  });
});
