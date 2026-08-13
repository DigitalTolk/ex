import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// assistant-ui's primitives are context-driven views over a live streaming
// runtime. Standing that up would test assistant-ui, not ex. These stubs render
// the primitives' children and CALL their `components` render props, so every
// piece of the panel ex actually wrote — the session probe, the transport
// closures, the seed handoff, the welcome card, the composer, both message
// shapes — is exercised for real.
const appendMock = vi.hoisted(() => vi.fn());
const transportConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const runtimeOptions = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@assistant-ui/react', () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useThreadRuntime: () => ({ append: appendMock }),
  ThreadPrimitive: {
    Root: ({ children }: { children: ReactNode }) => <div data-testid="thread">{children}</div>,
    Viewport: ({ children }: { children: ReactNode }) => <div data-testid="viewport">{children}</div>,
    Empty: ({ children }: { children: ReactNode }) => <div data-testid="empty">{children}</div>,
    // Rendered for both branches so the Send and Cancel affordances are both covered.
    If: ({ children }: { children: ReactNode }) => <>{children}</>,
    Messages: ({
      components,
    }: {
      components: { UserMessage: React.ComponentType; AssistantMessage: React.ComponentType };
    }) => (
      <>
        <components.UserMessage />
        <components.AssistantMessage />
      </>
    ),
  },
  MessagePrimitive: {
    Root: ({ children }: { children: ReactNode }) => <div data-testid="message">{children}</div>,
    Parts: ({
      components,
    }: {
      components: {
        Text: React.ComponentType;
        tools?: { Fallback: React.ComponentType<{ toolName: string }> };
      };
    }) => (
      <>
        <components.Text />
        {components.tools ? <components.tools.Fallback toolName="executeApi" /> : null}
      </>
    ),
  },
  ComposerPrimitive: {
    Root: ({ children }: { children: ReactNode }) => <form data-testid="composer">{children}</form>,
    Input: (props: Record<string, unknown>) => <textarea aria-label="Ask Cliffy" {...props} />,
    Send: ({ children, ...p }: { children: ReactNode }) => (
      <button type="submit" aria-label="Send to Cliffy" {...p}>
        {children}
      </button>
    ),
    Cancel: ({ children, ...p }: { children: ReactNode }) => (
      <button type="button" aria-label="Stop Cliffy" {...p}>
        {children}
      </button>
    ),
  },
}));

vi.mock('@assistant-ui/react-ai-sdk', () => ({
  useChatRuntime: (opts: Record<string, unknown>) => {
    runtimeOptions.current = opts;
    return { runtime: 'stub' };
  },
  AssistantChatTransport: class {
    constructor(cfg: Record<string, unknown>) {
      transportConfigs.push(cfg);
    }
  },
}));

vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: () => true }));

vi.mock('./cliffy-tools', () => ({
  MarkdownText: () => <div data-testid="markdown-text" />,
  ToolFallback: ({ toolName }: { toolName: string }) => <div data-testid="tool-fallback">{toolName}</div>,
  WriteApiToolUI: () => <div data-testid="write-tool" />,
  OpenPageToolUI: () => <div data-testid="openpage-tool" />,
}));

const apiFetchMock = vi.hoisted(() => vi.fn());
const tokenState = vi.hoisted(() => ({ current: 'tok-1' as string | null }));

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getAccessToken: () => tokenState.current,
  ApiError: class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const { CliffyPanel } = await import('./CliffyPanel');
const { useCliffyStore } = await import('./cliffy-store');
const { ApiError } = await import('@/lib/api');

/** A probe that stays pending, so the loading state can be observed. */
function pending() {
  return new Promise(() => {});
}

beforeEach(() => {
  apiFetchMock.mockReset();
  appendMock.mockReset();
  transportConfigs.length = 0;
  runtimeOptions.current = null;
  tokenState.current = 'tok-1';
  useCliffyStore.setState({ scope: null, cliffhubBase: null, seedPrompt: null });
});

describe('CliffyPanel session probe', () => {
  it('shows a connecting state while the bridge session is being established', () => {
    apiFetchMock.mockImplementation(pending);
    render(<CliffyPanel onClose={vi.fn()} />);
    expect(screen.getByText('Connecting to Cliffy…')).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/cliffy/session', { method: 'POST' });
  });

  it('records the CliffHub origin the probe reports and mounts the thread', async () => {
    apiFetchMock.mockResolvedValue({ cliffhub_base: 'https://hub.example.test' });
    render(<CliffyPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('thread')).toBeInTheDocument());
    // The origin is what turns Cliffy's relative /tasks/<id> links into
    // openable CliffHub links in ex.
    expect(useCliffyStore.getState().cliffhubBase).toBe('https://hub.example.test');
  });

  it('treats a probe with no origin, or no body at all, as simply unknown', async () => {
    apiFetchMock.mockResolvedValue({});
    const { unmount } = render(<CliffyPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('thread')).toBeInTheDocument());
    expect(useCliffyStore.getState().cliffhubBase).toBeNull();
    unmount();

    apiFetchMock.mockResolvedValue(null);
    render(<CliffyPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('thread')).toBeInTheDocument());
    expect(useCliffyStore.getState().cliffhubBase).toBeNull();
  });

  it('explains a 403 as a missing CliffHub profile rather than as an error', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(<CliffyPanel onClose={vi.fn()} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Cliffy isn't available for your account/),
      ).toBeInTheDocument(),
    );
    // No retry offered — retrying can't produce an account.
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('offers a retry for any other failure, and the retry re-probes', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<CliffyPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Couldn't reach Cliffy.")).toBeInTheDocument());

    apiFetchMock.mockResolvedValueOnce({ cliffhub_base: 'https://hub.example.test' });
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(screen.getByTestId('thread')).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a non-403 ApiError as a retryable failure', async () => {
    apiFetchMock.mockRejectedValue(new ApiError(502, 'bad gateway'));
    render(<CliffyPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Couldn't reach Cliffy.")).toBeInTheDocument());
  });

  it('drops a probe that resolves after the panel closed', async () => {
    let resolve: ((v: unknown) => void) | undefined;
    apiFetchMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { unmount } = render(<CliffyPanel onClose={vi.fn()} />);
    unmount();
    // Landing a state update on an unmounted panel is the classic React leak;
    // the cancelled flag is what prevents it.
    resolve!({ cliffhub_base: 'https://hub.example.test' });
    await Promise.resolve();
    expect(useCliffyStore.getState().cliffhubBase).toBeNull();
  });

  it('drops a probe that fails after the panel closed', async () => {
    let reject: ((e: unknown) => void) | undefined;
    apiFetchMock.mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const { unmount } = render(<CliffyPanel onClose={vi.fn()} />);
    unmount();
    reject!(new Error('offline'));
    await Promise.resolve();
    expect(screen.queryByText("Couldn't reach Cliffy.")).toBeNull();
  });

  it('closes on the header button', () => {
    apiFetchMock.mockImplementation(pending);
    const onClose = vi.fn();
    render(<CliffyPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Cliffy' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CliffyPanel transport', () => {
  beforeEach(() => {
    apiFetchMock.mockResolvedValue({ cliffhub_base: 'https://hub.example.test' });
  });

  async function mountReady() {
    const view = render(<CliffyPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('thread')).toBeInTheDocument());
    return view;
  }

  it('streams through ex’s proxy and authenticates with the ex access token', async () => {
    await mountReady();
    const cfg = transportConfigs[0];
    expect(cfg.api).toBe('/api/v1/cliffy/chat');
    expect((cfg.headers as () => Record<string, string>)()).toEqual({ Authorization: 'Bearer tok-1' });
  });

  it('sends an empty bearer rather than "undefined" when there is no token', async () => {
    tokenState.current = null;
    await mountReady();
    expect((transportConfigs[0].headers as () => Record<string, string>)()).toEqual({
      Authorization: 'Bearer ',
    });
  });

  it('sends no context when the panel was opened outside a conversation', async () => {
    await mountReady();
    expect((transportConfigs[0].body as () => unknown)()).toEqual({});
  });

  it('sends the scope so the server can fetch that conversation’s transcript', async () => {
    useCliffyStore.setState({ scope: { type: 'channel', id: 'c-1', name: 'general' } });
    await mountReady();
    expect((transportConfigs[0].body as () => unknown)()).toEqual({
      context: {
        scope: { type: 'channel', id: 'c-1', name: 'general' },
        page: { title: 'general', type: 'ex-conversation' },
      },
    });
  });

  it('titles the page hint with the id when the scope has no name', async () => {
    useCliffyStore.setState({ scope: { type: 'conversation', id: 'd-1' } });
    await mountReady();
    const body = (transportConfigs[0].body as () => { context: { page: { title: string } } })();
    expect(body.context.page.title).toBe('d-1');
  });

  it('runs the tool loop automatically once an assistant turn is complete', async () => {
    await mountReady();
    expect(typeof runtimeOptions.current!.sendAutomaticallyWhen).toBe('function');
    expect(runtimeOptions.current!.transport).toBeDefined();
  });
});

describe('CliffyPanel thread', () => {
  beforeEach(() => {
    apiFetchMock.mockResolvedValue({ cliffhub_base: 'https://hub.example.test' });
  });

  async function mountReady() {
    const view = render(<CliffyPanel onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('thread')).toBeInTheDocument());
    return view;
  }

  it('sends a /cliffy seed prompt once the runtime is up', async () => {
    useCliffyStore.setState({ seedPrompt: 'create a task for Habib' });
    await mountReady();
    await waitFor(() => expect(appendMock).toHaveBeenCalledTimes(1));
    expect(appendMock).toHaveBeenCalledWith({
      role: 'user',
      content: [{ type: 'text', text: 'create a task for Habib' }],
    });
    // Consumed, so a later re-mount doesn't re-send it.
    expect(useCliffyStore.getState().seedPrompt).toBeNull();
  });

  it('sends nothing when the panel was opened without a seed', async () => {
    await mountReady();
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('offers starter prompts that send on click', async () => {
    await mountReady();
    expect(screen.getByText('How can I help?')).toBeInTheDocument();
    for (const label of ['Show my open tasks', 'Who is on leave this week?', 'Create a task']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Show my open tasks' }));
    expect(appendMock).toHaveBeenCalledWith({
      role: 'user',
      content: [{ type: 'text', text: 'Show my open tasks' }],
    });
  });

  it('shows which conversation Cliffy is answering about, and nothing when there is none', async () => {
    const { unmount } = await mountReady();
    expect(screen.queryByText('general')).toBeNull();
    unmount();

    useCliffyStore.setState({ scope: { type: 'channel', id: 'c-1', name: 'general' } });
    await mountReady();
    expect(screen.getByText('general')).toBeInTheDocument();
  });

  it('falls back to the scope id in the chip when there is no name', async () => {
    useCliffyStore.setState({ scope: { type: 'conversation', id: 'd-1' } });
    await mountReady();
    expect(screen.getByText('d-1')).toBeInTheDocument();
  });

  it('mounts the composer with both a send and a stop affordance', async () => {
    await mountReady();
    expect(screen.getByLabelText('Ask Cliffy')).toBeInTheDocument();
    expect(screen.getByLabelText('Send to Cliffy')).toBeInTheDocument();
    expect(screen.getByLabelText('Stop Cliffy')).toBeInTheDocument();
    expect(screen.getByText(/Cliffy can make mistakes/)).toBeInTheDocument();
  });

  it('renders user turns as markdown and assistant turns with the tool fallback', async () => {
    await mountReady();
    // Both message shapes render markdown; only the assistant one shows tool
    // progress, since only it makes tool calls.
    expect(screen.getAllByTestId('markdown-text')).toHaveLength(2);
    expect(screen.getByTestId('tool-fallback').textContent).toBe('executeApi');
    expect(screen.getByTestId('write-tool')).toBeInTheDocument();
    expect(screen.getByTestId('openpage-tool')).toBeInTheDocument();
  });
});
