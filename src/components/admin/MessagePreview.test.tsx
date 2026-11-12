import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagePreview } from './MessagePreview';
import { FORM_TEMPLATES, MESSAGE_TEMPLATES, pretty } from './builderTemplates';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
const mockCopy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: (...args: unknown[]) => mockCopy(...args) }));

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
  mockCopy.mockReset();
  mockCopy.mockResolvedValue(true);
});

const payloadBox = () => screen.getByTestId('message-preview-payload') as HTMLTextAreaElement;
const edit = (value: string) => fireEvent.change(payloadBox(), { target: { value } });

// copiedCurl copies the payload as a command and splits it: the command's
// lines up to the heredoc, the body the heredoc feeds curl, and its end.
async function copiedCurl() {
  fireEvent.click(screen.getByRole('button', { name: 'Copy as cURL' }));
  await waitFor(() => expect(mockCopy).toHaveBeenCalled());
  const command = mockCopy.mock.calls.at(-1)![0] as string;
  const lines = command.split('\n');
  const start = lines.findIndex((l) => l.endsWith("<<'JSON'"));
  // The shell ends the body at the first line reading JSON — which must be
  // the command's last line.
  const end = lines.indexOf('JSON');
  return { command, head: lines.slice(0, start + 1).join('\n'), body: lines.slice(start + 1, end).join('\n'), end, last: lines.length - 1 };
}

// A form preview as the server returns one: the view, checked and hashed.
const previewedView = (over: Record<string, unknown> = {}) => ({
  id: 'preview',
  type: 'modal',
  hash: 'p1',
  title: { type: 'plain_text', text: 'Share feedback' },
  submit: { type: 'plain_text', text: 'Send' },
  blocks: [
    { type: 'section', block_id: 's1', text: { type: 'markdown', text: 'How did the **offsite** go?' } },
    {
      type: 'input',
      block_id: 'rating',
      label: { type: 'plain_text', text: 'Overall' },
      element: { type: 'radio_buttons', action_id: 'r', options: [{ text: { type: 'plain_text', text: 'Great' }, value: 'great' }, { text: { type: 'plain_text', text: 'Fine' }, value: 'ok' }] },
    },
    { type: 'input', block_id: 'comments', label: { type: 'plain_text', text: 'Anything else?' }, optional: true, element: { type: 'plain_text_input', action_id: 'c', multiline: true } },
  ],
  ...over,
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

  it("shows the server's reason for refusing a payload, and the template again on request", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('blocks[0]: a header needs text'));
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    await settle();
    await waitFor(() => expect(screen.getByTestId('message-preview-error')).toHaveTextContent('blocks[0]: a header needs text'));
    expect(screen.getByTestId('message-preview-result')).toHaveTextContent('The message shows here.');

    mockApiFetch.mockRejectedValueOnce('down');
    edit('{"text":"x"}');
    await settle();
    await waitFor(() => expect(screen.getByTestId('message-preview-error')).toHaveTextContent('Preview failed'));

    // The template picked stays marked; picking it again brings it back.
    const deploy = screen.getByTestId('builder-template-deploy');
    expect(deploy).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(deploy);
    expect(payloadBox().value).toBe(pretty(MESSAGE_TEMPLATES[0].payload));
  });

  it('starts from any message template', async () => {
    mockApiFetch.mockResolvedValue(previewed);
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    const group = screen.getByRole('group', { name: 'Templates' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(MESSAGE_TEMPLATES.map((t) => t.label));
    fireEvent.click(screen.getByTestId('builder-template-triage'));
    expect(screen.getByTestId('builder-template-triage')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('builder-template-deploy')).toHaveAttribute('aria-pressed', 'false');
    expect(payloadBox().value).toBe(pretty(MESSAGE_TEMPLATES.find((t) => t.key === 'triage')!.payload));
    await settle();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/webhooks/preview', { method: 'POST', body: payloadBox().value }));
  });

  it('builds a form: its own templates, checked as views.open checks it, drawn with fields to try', async () => {
    mockApiFetch.mockImplementation((path: string) => Promise.resolve(path.endsWith('/preview-view') ? previewedView() : previewed));
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    fireEvent.click(screen.getByTestId('builder-mode-form'));
    expect(screen.getByTestId('builder-mode-form')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('builder-mode-message')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByLabelText(/^View/)).toBe(payloadBox());
    expect(within(screen.getByRole('group', { name: 'Templates' })).getAllByRole('button').map((b) => b.textContent)).toEqual(FORM_TEMPLATES.map((t) => t.label));
    expect(payloadBox().value).toBe(pretty(FORM_TEMPLATES[0].payload));
    expect(screen.getByText(/Submit goes to your app once it opens the form for real/)).toBeInTheDocument();

    await settle();
    const preview = await screen.findByTestId('builder-form-preview');
    // The form and its message changed together: the form went to the form's
    // check, and no form was ever sent to the message's (or the reverse).
    for (const [path, init] of mockApiFetch.mock.calls as [string, { body: string }][]) {
      expect(JSON.parse(init.body).type === 'modal').toBe(path === '/api/v1/admin/webhooks/preview-view');
    }
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/webhooks/preview-view', { method: 'POST', body: pretty(FORM_TEMPLATES[0].payload) });
    expect(within(preview).getByText('Share feedback')).toBeInTheDocument();
    expect(within(preview).getByText('offsite').tagName).toBe('STRONG');

    // Fields work, so they can be tried.
    const great = within(preview).getByLabelText('Great');
    fireEvent.click(great);
    expect(great).toBeChecked();
    fireEvent.change(screen.getByTestId('builder-comments'), { target: { value: 'More coffee' } });
    expect(screen.getByTestId('builder-comments')).toHaveValue('More coffee');
    // ⌘Enter, which sends a real form, sends nothing from here.
    const asked = mockApiFetch.mock.calls.length;
    fireEvent.keyDown(screen.getByTestId('builder-comments'), { key: 'Enter', metaKey: true });
    await settle();
    expect(mockApiFetch).toHaveBeenCalledTimes(asked);
    expect(screen.getByTestId('builder-form-preview')).toBeInTheDocument();
    // Its buttons are shown, not live: Submit goes to the app.
    expect(within(preview).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    const send = within(preview).getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('title', 'Submit goes to your app');
  });

  it("draws a form without a submit button, with the app's close label", async () => {
    mockApiFetch.mockResolvedValue(previewedView({ submit: undefined, close: { type: 'plain_text', text: 'Not now' } }));
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    fireEvent.click(screen.getByTestId('builder-mode-form'));
    fireEvent.click(screen.getByTestId('builder-template-bug'));
    expect(payloadBox().value).toBe(pretty(FORM_TEMPLATES.find((t) => t.key === 'bug')!.payload));
    await settle();
    const preview = await screen.findByTestId('builder-form-preview');
    expect(within(preview).getByRole('button', { name: 'Not now' })).toBeDisabled();
    expect(within(preview).queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it("shows where the form goes while it can't be drawn", async () => {
    mockApiFetch.mockRejectedValue(new Error('blocks[1]: a field needs a label'));
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    fireEvent.click(screen.getByTestId('builder-mode-form'));
    await settle();
    await waitFor(() => expect(screen.getByTestId('message-preview-error')).toHaveTextContent('blocks[1]: a field needs a label'));
    expect(screen.getByTestId('message-preview-result')).toHaveTextContent('The form shows here.');
    expect(payloadBox()).toHaveAttribute('aria-describedby', 'message-preview-error');
  });

  describe('copy as cURL', () => {
    it("posts a message to the webhook's URL, with the payload as JSON", async () => {
      mockApiFetch.mockResolvedValue(previewed);
      renderPreview();
      fireEvent.click(screen.getByTestId('message-preview-toggle'));
      edit('{"text":"Deploy finished"}');
      const { head, body, end, last } = await copiedCurl();
      expect(head).toBe(
        `curl -X POST "$EX_WEBHOOK_URL" \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $EX_BOT_TOKEN" \\\n  --data-binary @- <<'JSON'`,
      );
      // Re-serialized, not the text as typed.
      expect(body).toBe('{\n  "text": "Deploy finished"\n}');
      expect(end).toBe(last);
    });

    it('opens a form with views.open, wrapping the view with the trigger from the click', async () => {
      mockApiFetch.mockResolvedValue(previewedView());
      renderPreview();
      fireEvent.click(screen.getByTestId('message-preview-toggle'));
      fireEvent.click(screen.getByTestId('builder-mode-form'));
      const { head, body, end, last } = await copiedCurl();
      expect(head.split('\n')[0]).toBe(`curl -X POST '${window.location.origin}/api/v1/apps/views.open' \\`);
      expect(JSON.parse(body)).toEqual({ trigger_id: 'TRIGGER_ID_FROM_THE_CLICK', view: FORM_TEMPLATES[0].payload });
      expect(end).toBe(last);
    });

    it('keeps a pasted line reading JSON inside the body, and offers no command for text that is not JSON', async () => {
      mockApiFetch.mockResolvedValue(previewed);
      renderPreview();
      fireEvent.click(screen.getByTestId('message-preview-toggle'));
      // A value that, written out, has a line reading JSON and a command after it.
      edit('{"text": "done\\nJSON\\ntouch /tmp/pwned"}');
      const { body, end, last } = await copiedCurl();
      expect(end).toBe(last);
      expect(JSON.parse(body)).toEqual({ text: 'done\nJSON\ntouch /tmp/pwned' });

      // Pasted as is, the line would end the heredoc and run what follows: as
      // that isn't JSON, there's no command to copy — only the JSON itself.
      edit('{"text": "done"}\nJSON\ntouch /tmp/pwned');
      expect(screen.queryByRole('button', { name: 'Copy as cURL' })).toBeNull();
      expect(screen.queryByTestId('builder-copy-curl')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
      await waitFor(() => expect(mockCopy).toHaveBeenLastCalledWith('{"text": "done"}\nJSON\ntouch /tmp/pwned'));
    });
  });

  it('closes again', () => {
    renderPreview();
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    fireEvent.click(screen.getByTestId('message-preview-toggle'));
    expect(screen.queryByTestId('message-preview-payload')).toBeNull();
  });
});
