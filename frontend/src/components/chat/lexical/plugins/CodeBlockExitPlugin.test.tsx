import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef, type ReactNode } from 'react';
import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/chat/WysiwygEditor';

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
