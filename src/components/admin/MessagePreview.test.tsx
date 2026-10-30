import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagePreview } from './MessagePreview';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));

function renderPreview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MessagePreview />
    </QueryClientProvider>,
  );
}

const previewed = {
  id: 'preview',
  authorID: 'webhook',
  body: 'Deploy finished',
  createdAt: '2026-10-30T10:00:00Z',
  webhookUsername: 'Release bot',
  blocks: [{ type: 'header', block_id: 'b1', text: { type: 'plain_text', text: 'Deploy finished' } }],
  messageAttachments: [{ text: 'card text' }],
};

// The preview waits for typing to pause (400 ms) before asking the server.
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(450);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockApiFetch.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MessagePreview', () => {
  it('sends nothing until it is opened', async () => {
    renderPreview();
    await settle();
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('message-preview-payload')).toBeNull();
    expect(screen.getByTestId('message-preview-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('checks the example with the server and draws the result', async () => {
    mockApiFetch.mockResolvedValue(previewed);
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    await settle();
    await waitFor(() => expect(screen.getByTestId('message-preview-result')).toHaveTextContent('Release bot'));
    const [path, init] = mockApiFetch.mock.calls[0];
    expect(path).toBe('/api/v1/admin/webhooks/preview');
    expect(JSON.parse(init.body).blocks.length).toBeGreaterThan(0);
    expect(screen.getByTestId('message-blocks')).toHaveTextContent('Deploy finished');
    expect(screen.getByText('card text')).toBeInTheDocument();
  });

  it('shows the text of a message without blocks', async () => {
    mockApiFetch.mockResolvedValue({ ...previewed, blocks: undefined, body: '**hello**', messageAttachments: undefined });
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    await settle();
    await waitFor(() => expect(screen.getByText('hello').tagName).toBe('STRONG'));
  });

  it('flags JSON it can not read without asking the server', async () => {
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    fireEvent.change(screen.getByTestId('message-preview-payload'), { target: { value: '{"blocks": [' } });
    await settle();
    expect(screen.getByTestId('message-preview-error')).toHaveTextContent('Not valid JSON');
    expect(screen.getByTestId('message-preview-payload')).toHaveAttribute('aria-invalid', 'true');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/admin/webhooks/preview', { method: 'POST', body: '{"blocks": [' });
  });

  it("shows the server's reason for refusing a payload, and the example again on request", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('blocks[0]: a header needs text'));
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    await settle();
    await waitFor(() => expect(screen.getByTestId('message-preview-error')).toHaveTextContent('blocks[0]: a header needs text'));

    mockApiFetch.mockRejectedValueOnce('down');
    fireEvent.change(screen.getByTestId('message-preview-payload'), { target: { value: '{"text":"x"}' } });
    await settle();
    await waitFor(() => expect(screen.getByTestId('message-preview-error')).toHaveTextContent('Preview failed'));

    fireEvent.click(screen.getByTestId('message-preview-reset'));
    expect((screen.getByTestId('message-preview-payload') as HTMLTextAreaElement).value).toContain('"blocks"');
  });

  it('closes again', () => {
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    expect(screen.queryByTestId('message-preview-payload')).toBeNull();
  });
});
