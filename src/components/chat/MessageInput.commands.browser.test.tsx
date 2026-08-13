import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput } from './MessageInput';
import { setWSSender } from '@/lib/ws-sender';

// End-to-end slash-command flow in the REAL composer: type "/" → the command
// popup opens → accept the completion → send → the commands API is invoked
// (instead of onSend) and the composer clears.

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
  useWorkspaceSettings: () => ({ data: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false, giphyAPIKey: '' } }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useAllUsers: () => ({ data: [] }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));

const runCommandMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useCommands', () => ({
  useCommands: (enabled?: boolean) => ({
    data: enabled ? [{ name: 'mstmeetings', description: 'Start a Microsoft Teams meeting' }] : [],
  }),
  useRunCommand: () => ({ mutate: runCommandMock }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('MessageInput slash-command flow (real composer)', () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    setWSSender(vi.fn());
  });

  it('typing "/" opens the command popup; accepting + sending runs the command', async () => {
    const onSend = vi.fn();
    const screen = await renderWithProviders(
      <MessageInput onSend={onSend} typingParentID="chan-1" typingParentType="channel" />,
    );

    await screen.getByLabelText('Message input').click();
    await userEvent.keyboard('/mst');

    // The popup renders the command row (rich renderer: name + description).
    await vi.waitFor(() => {
      const title = document.querySelector('.cm-tooltip-autocomplete .cm-option-title');
      expect(title?.textContent).toBe('/mstmeetings');
    });

    // Outwait CM's accept interaction delay, then Tab-accept the completion.
    await new Promise((r) => setTimeout(r, 120));
    await userEvent.keyboard('{Tab}');
    await vi.waitFor(() => {
      const editor = screen.getByLabelText('Message input').element();
      expect(editor.textContent).toBe('/mstmeetings');
    });

    // Send via the button — uniform across desktop and mobile viewports
    // (mobile composers don't submit on Enter).
    await screen.getByLabelText('Send message').click();
    await vi.waitFor(() => {
      expect(runCommandMock).toHaveBeenCalledTimes(1);
    });
    expect(runCommandMock.mock.calls[0][0]).toEqual({
      command: 'mstmeetings',
      parentType: 'channel',
      parentID: 'chan-1',
      // Arguments after the trigger word; empty for a bare built-in command.
      text: '',
    });
    expect(onSend).not.toHaveBeenCalled();
    // The in-flight status line shows while the command runs server-side
    // (the mock never settles, so it stays up).
    await vi.waitFor(() => {
      expect(screen.getByTestId('command-pending').element().textContent).toContain('Running /mstmeetings…');
    });
    // The composer clears like a normal send.
    await vi.waitFor(() => {
      expect(screen.getByLabelText('Message input').element().textContent).toBe('');
    });
  });
});
