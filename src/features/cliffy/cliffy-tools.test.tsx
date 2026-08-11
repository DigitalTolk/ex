import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType, AnchorHTMLAttributes } from 'react';

// assistant-ui's tool renderers and markdown primitive only work inside a live
// assistant runtime, which would drag the whole streaming stack into a unit
// test. Capture what this module HANDS to them instead, then exercise those
// pieces directly — that is exactly the ex-specific behaviour worth testing.
type ToolUIConfig = {
  toolName: string;
  render: (p: {
    args?: Record<string, unknown>;
    result?: Record<string, unknown>;
    addResult: (r: unknown) => void;
  }) => React.ReactNode;
};
const toolUIs = vi.hoisted(() => new Map<string, unknown>());
const markdownProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@assistant-ui/react', () => ({
  makeAssistantToolUI: (cfg: ToolUIConfig) => {
    toolUIs.set(cfg.toolName, cfg);
    return () => null;
  },
}));

vi.mock('@assistant-ui/react-markdown', () => ({
  MarkdownTextPrimitive: (props: Record<string, unknown>) => {
    markdownProps.current = props;
    return <div data-testid="markdown" />;
  },
}));

const tokenState = vi.hoisted(() => ({ current: 'tok-123' as string | null }));
vi.mock('@/lib/api', () => ({ getAccessToken: () => tokenState.current }));

const { MarkdownText, ToolFallback } = await import('./cliffy-tools');
const { useCliffyStore } = await import('./cliffy-store');

function toolUI(name: string) {
  return toolUIs.get(name) as ToolUIConfig;
}

/** Render a tool card the way the runtime would: args, maybe a result, addResult. */
function renderTool(
  name: string,
  p: { args?: Record<string, unknown>; result?: Record<string, unknown>; addResult?: (r: unknown) => void },
) {
  const addResult = p.addResult ?? vi.fn();
  return {
    addResult,
    ...render(<>{toolUI(name).render({ args: p.args, result: p.result, addResult })}</>),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  tokenState.current = 'tok-123';
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as never;
  useCliffyStore.setState({ scope: null, cliffhubBase: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MarkdownText', () => {
  it('renders CliffHub-aware markdown with GFM enabled', () => {
    render(<MarkdownText />);
    expect(screen.getByTestId('markdown')).toBeInTheDocument();
    expect(markdownProps.current).not.toBeNull();
    // GFM is what makes the agent's tables and task lists render at all.
    expect((markdownProps.current!.remarkPlugins as unknown[]).length).toBe(1);
    expect(typeof (markdownProps.current!.components as Record<string, unknown>).a).toBe('function');
  });
});

describe('the CliffHub anchor markdown links are rendered with', () => {
  // Cliffy talks about CliffHub, so its links are relative to CliffHub — not to
  // ex, where a relative href would resolve to an ex route that doesn't exist.
  let Anchor: ComponentType<AnchorHTMLAttributes<HTMLAnchorElement>>;

  beforeEach(() => {
    const { unmount } = render(<MarkdownText />);
    Anchor = (markdownProps.current!.components as {
      a: ComponentType<AnchorHTMLAttributes<HTMLAnchorElement>>;
    }).a;
    unmount();
  });

  function renderAnchor(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
    const { container } = render(<Anchor {...props} />);
    return container.querySelector('a')!;
  }

  it('absolutizes a relative CliffHub path against the probed origin and opens it in a new tab', () => {
    useCliffyStore.setState({ cliffhubBase: 'https://hub.example.test' });
    const a = renderAnchor({ href: '/tasks/t-1', children: 'task' });
    expect(a.getAttribute('href')).toBe('https://hub.example.test/tasks/t-1');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('leaves a relative path alone when no CliffHub origin is known yet', () => {
    const a = renderAnchor({ href: '/tasks/t-1', children: 'task' });
    expect(a.getAttribute('href')).toBe('/tasks/t-1');
    expect(a.getAttribute('target')).toBeNull();
  });

  it('treats an absolute http(s) link as external without rewriting it', () => {
    useCliffyStore.setState({ cliffhubBase: 'https://hub.example.test' });
    const a = renderAnchor({ href: 'https://elsewhere.example/doc', children: 'doc' });
    expect(a.getAttribute('href')).toBe('https://elsewhere.example/doc');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('does not prefix a protocol-relative href — //host is another origin, not a CliffHub path', () => {
    useCliffyStore.setState({ cliffhubBase: 'https://hub.example.test' });
    const a = renderAnchor({ href: '//evil.example/x', children: 'x' });
    expect(a.getAttribute('href')).toBe('//evil.example/x');
    expect(a.getAttribute('target')).toBeNull();
  });

  it('renders an href-less anchor as plain, non-external text', () => {
    const a = renderAnchor({ children: 'nowhere' });
    expect(a.getAttribute('href')).toBeNull();
    expect(a.getAttribute('target')).toBeNull();
    expect(a.textContent).toBe('nowhere');
  });
});

describe('ToolFallback', () => {
  it('labels each read tool in the user’s language', () => {
    for (const [tool, label] of [
      ['executeApi', 'Looking that up…'],
      ['queryKnowledgeBase', 'Finding the right action…'],
      ['search', 'Searching…'],
      ['searchDocs', 'Searching the docs…'],
      ['readDocSection', 'Reading the docs…'],
    ] as const) {
      const { unmount } = render(<ToolFallback toolName={tool} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it('falls back to a generic chip for a tool it has no wording for', () => {
    render(<ToolFallback toolName="somethingBrandNew" />);
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });
});

describe('writeApi approval card', () => {
  const args = { method: 'POST', path: '/api/tasks', body: { title: 'x' }, summary: 'Create a task' };

  it('is registered as the writeApi tool renderer', () => {
    expect(toolUI('writeApi').toolName).toBe('writeApi');
  });

  it('asks before doing anything — nothing is called until Approve', () => {
    const { addResult } = renderTool('writeApi', { args });
    expect(screen.getByText('Approve this action?')).toBeInTheDocument();
    expect(screen.getByText('Create a task')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(addResult).not.toHaveBeenCalled();
  });

  it('runs an approved call through the write passthrough and reports the outcome back', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Task created', id: 't-9' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { addResult } = renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(addResult).toHaveBeenCalledTimes(1));
    // The passthrough is what injects the bridged CliffHub token server-side —
    // the browser must never hold it, so only ex's own bearer goes out here.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/cliffy/api');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(init.body as string)).toEqual({
      method: 'POST',
      path: '/api/tasks',
      body: { title: 'x' },
    });
    expect(addResult.mock.calls[0][0]).toEqual({
      approved: true,
      executed: true,
      ok: true,
      status: 201,
      message: 'Task created',
      data: { message: 'Task created', id: 't-9' },
    });
    // Busy state latches so a double-click can't fire the write twice.
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
  });

  it('forwards a rejected write’s status and validation body to the agent', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'title is required' }), { status: 422 }),
    );
    const { addResult } = renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(addResult).toHaveBeenCalled());
    // A raw fetch, not apiFetch, precisely so the agent sees WHY it failed.
    expect(addResult.mock.calls[0][0]).toMatchObject({
      approved: true,
      executed: true,
      ok: false,
      status: 422,
      message: 'title is required',
    });
  });

  it('reports a body it could not parse as a null result rather than crashing', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    const { addResult } = renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(addResult).toHaveBeenCalled());
    expect(addResult.mock.calls[0][0]).toMatchObject({ ok: false, status: 502, data: null });
    expect(addResult.mock.calls[0][0].message).toBeUndefined();
  });

  it('reports a transport failure as approved-but-not-executed', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { addResult } = renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(addResult).toHaveBeenCalled());
    // executed:false matters — the agent must not assume the write landed.
    expect(addResult.mock.calls[0][0]).toEqual({
      approved: true,
      executed: false,
      ok: false,
      error: 'offline',
    });
  });

  it('stringifies a non-Error rejection', async () => {
    fetchMock.mockRejectedValue('kaboom');
    const { addResult } = renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(addResult).toHaveBeenCalled());
    expect(addResult.mock.calls[0][0].error).toBe('kaboom');
  });

  it('truncates an oversized response so a huge payload cannot flood the context', async () => {
    const big = { blob: 'x'.repeat(6000) };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(big), { status: 200 }));
    const { addResult } = renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(addResult).toHaveBeenCalled());
    const data = addResult.mock.calls[0][0].data as string;
    expect(typeof data).toBe('string');
    expect(data.endsWith('…[truncated]')).toBe(true);
    expect(data.length).toBe(4000 + '…[truncated]'.length);
  });

  it('ignores a message field that is blank or not a string', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: '   ' }), { status: 200 }));
    const { addResult } = renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(addResult).toHaveBeenCalled());
    expect(addResult.mock.calls[0][0].message).toBeUndefined();

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 12 }), { status: 200 }));
    const second = renderTool('writeApi', { args });
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await waitFor(() => expect(second.addResult).toHaveBeenCalled());
    expect(second.addResult.mock.calls[0][0].message).toBeUndefined();
  });

  it('forwards a query the agent supplied', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    renderTool('writeApi', { args: { ...args, query: { notify: 'true' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).query).toEqual({ notify: 'true' });
  });

  it('omits a body the agent did not send — a DELETE has none', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    renderTool('writeApi', { args: { method: 'DELETE', path: '/api/tasks/9', summary: 'Delete task 9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ method: 'DELETE', path: '/api/tasks/9' });
    expect('body' in sent).toBe(false);
  });

  it('sends an empty bearer rather than "undefined" with no access token', async () => {
    tokenState.current = null;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer ');
  });

  it('Reject settles the tool without calling anything', () => {
    const { addResult } = renderTool('writeApi', { args });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(addResult).toHaveBeenCalledWith({ approved: false, executed: false, rejected: true });
  });

  it('does nothing when the agent proposed a call with no method or path', () => {
    const { addResult } = renderTool('writeApi', { args: { summary: 'half a proposal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(addResult).not.toHaveBeenCalled();
  });

  it('falls back to method + path, then to a generic phrase, when the agent sends no summary', () => {
    const { unmount } = renderTool('writeApi', { args: { method: 'DELETE', path: '/api/tasks/9' } });
    expect(screen.getByText('DELETE /api/tasks/9')).toBeInTheDocument();
    unmount();

    renderTool('writeApi', { args: undefined });
    expect(screen.getByText('this action')).toBeInTheDocument();
  });

  it('shows a settled call as completed and hides the approve/reject buttons', () => {
    renderTool('writeApi', { args, result: { approved: true, executed: true, ok: true, status: 200 } });
    expect(screen.getByText('Action completed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('shows a rejected call as cancelled', () => {
    renderTool('writeApi', { args, result: { approved: false, executed: false, rejected: true } });
    expect(screen.getByText('Action cancelled')).toBeInTheDocument();
  });

  it('shows a failed call as failed, with the server’s reason', () => {
    renderTool('writeApi', {
      args,
      result: { approved: true, executed: true, ok: false, status: 422, message: 'title is required' },
    });
    expect(screen.getByText('Action failed')).toBeInTheDocument();
    expect(screen.getByText('title is required')).toBeInTheDocument();
  });

  it('shows a failed call with no reason without an empty detail line', () => {
    renderTool('writeApi', { args, result: { approved: true, executed: false, ok: false } });
    expect(screen.getByText('Action failed')).toBeInTheDocument();
  });

  it('offers no share button when the panel was not opened from a conversation', () => {
    renderTool('writeApi', { args, result: { approved: true, executed: true, ok: true } });
    expect(screen.queryByRole('button', { name: /^Share to/ })).toBeNull();
  });
});

describe('sharing a completed action back into the conversation', () => {
  const args = { method: 'POST', path: '/api/tasks', summary: 'Create a task' };
  const done = { approved: true, executed: true, ok: true, status: 201 };

  it('posts the summary to the scoped conversation and confirms it', async () => {
    useCliffyStore.setState({ scope: { type: 'channel', id: 'c-1', name: 'general' } });
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderTool('writeApi', { args, result: done });

    fireEvent.click(screen.getByRole('button', { name: 'Share to general' }));
    await waitFor(() => expect(screen.getByText('Shared to general')).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/cliffy/share');
    expect(JSON.parse(init.body as string)).toEqual({
      scope_type: 'channel',
      scope_id: 'c-1',
      text: '✅ Create a task',
    });
    // Confirmed state replaces the button, so it can't be posted twice.
    expect(screen.queryByRole('button', { name: /^Share to/ })).toBeNull();
  });

  it('shares with an empty bearer rather than "undefined" with no access token', async () => {
    tokenState.current = null;
    useCliffyStore.setState({ scope: { type: 'channel', id: 'c-1', name: 'general' } });
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderTool('writeApi', { args, result: done });
    fireEvent.click(screen.getByRole('button', { name: 'Share to general' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer ');
  });

  it('names the conversation generically when the scope has no name', async () => {
    useCliffyStore.setState({ scope: { type: 'conversation', id: 'd-1' } });
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderTool('writeApi', { args, result: done });
    fireEvent.click(screen.getByRole('button', { name: 'Share to conversation' }));
    await waitFor(() => expect(screen.getByText('Shared to the conversation')).toBeInTheDocument());
  });

  it('surfaces a rejected share and leaves the button available to retry', async () => {
    useCliffyStore.setState({ scope: { type: 'channel', id: 'c-1', name: 'general' } });
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    renderTool('writeApi', { args, result: done });

    fireEvent.click(screen.getByRole('button', { name: 'Share to general' }));
    await waitFor(() => expect(screen.getByText("Couldn't share")).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Share to general' })).toBeEnabled();
  });

  it('surfaces a share that never reached the server', async () => {
    useCliffyStore.setState({ scope: { type: 'channel', id: 'c-1', name: 'general' } });
    fetchMock.mockRejectedValue(new Error('offline'));
    renderTool('writeApi', { args, result: done });
    fireEvent.click(screen.getByRole('button', { name: 'Share to general' }));
    await waitFor(() => expect(screen.getByText("Couldn't share")).toBeInTheDocument());
  });

  it('disables the button while the share is in flight', async () => {
    useCliffyStore.setState({ scope: { type: 'channel', id: 'c-1', name: 'general' } });
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(new Response(null, { status: 204 })); }),
    );
    renderTool('writeApi', { args, result: done });

    fireEvent.click(screen.getByRole('button', { name: 'Share to general' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sharing…' })).toBeDisabled());
    release!();
    await waitFor(() => expect(screen.getByText('Shared to general')).toBeInTheDocument());
  });
});

describe('openPage tool', () => {
  it('is registered as the openPage renderer', () => {
    expect(toolUI('openPage').toolName).toBe('openPage');
  });

  it('prefers the executed result over the proposed args', () => {
    renderTool('openPage', {
      args: { path: '/tasks/proposed', label: 'proposed' },
      result: { ok: true, path: '/tasks/t-1', label: 'Fix the thing' },
    });
    expect(screen.getByText('Fix the thing')).toBeInTheDocument();
    expect(screen.getByText('(/tasks/t-1)')).toBeInTheDocument();
  });

  it('falls back to the args, and to the path itself when unlabelled', () => {
    const { unmount } = renderTool('openPage', { args: { path: '/tasks/t-2', label: 'Task two' } });
    expect(screen.getByText('Task two')).toBeInTheDocument();
    unmount();

    renderTool('openPage', { args: { path: '/tasks/t-3' } });
    expect(screen.getByText('/tasks/t-3')).toBeInTheDocument();
  });

  it('renders nothing at all with no path to point at', () => {
    const { container } = renderTool('openPage', { args: {} });
    expect(container.textContent).toBe('');
  });
});
