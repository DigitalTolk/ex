import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput } from './MessageInput';

// Slash-command send interception: a message that is exactly a registered
// command executes via the commands API instead of posting. These tests mock
// the command hooks (the hooks themselves are covered in useCommands.test.ts)
// and drive the real MessageInput send path.

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

vi.mock('@/hooks/useConversations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConversations')>()),
  useAllUsers: () => ({ data: [] }),
}));
vi.mock('@/hooks/useChannels', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useChannels')>()),
  useChannelMembers: () => ({ data: [] }),
  useUserChannels: () => ({ data: [] }),
}));
vi.mock('@/hooks/useEmoji', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useEmoji')>()),
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));
vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false } }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

const runCommandMock = vi.hoisted(() => vi.fn());
const useCommandsMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useCommands', () => ({
  useCommands: (enabled?: boolean) => useCommandsMock(enabled),
  useRunCommand: () => ({ mutate: runCommandMock }),
}));

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const COMMANDS = [{ name: 'mstmeetings', description: 'Start a Microsoft Teams meeting' }];

async function sendViaEnter() {
  const user = userEvent.setup();
  const editor = await screen.findByLabelText('Message input');
  editor.focus();
  await user.keyboard('{Enter}');
}

describe('MessageInput slash commands', () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    useCommandsMock.mockReset();
    useCommandsMock.mockImplementation((enabled?: boolean) => ({ data: enabled ? COMMANDS : [] }));
  });

  it('runs a registered command instead of sending a message', async () => {
    const onSend = vi.fn();
    render(
      <MessageInput
        onSend={onSend}
        initialBody="/mstmeetings"
        typingParentID="chan-1"
        typingParentType="channel"
      />,
    );
    await sendViaEnter();

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock.mock.calls[0][0]).toEqual({
      command: 'mstmeetings',
      parentType: 'channel',
      parentID: 'chan-1',
    });
    expect(onSend).not.toHaveBeenCalled();
    // The composer clears like a normal send.
    await waitFor(() => {
      expect(screen.getByLabelText('Message input').textContent).toBe('');
    });
  });

  it('matches command names case-insensitively', async () => {
    const onSend = vi.fn();
    render(
      <MessageInput
        onSend={onSend}
        initialBody="/MSTMeetings"
        typingParentID="conv-1"
        typingParentType="conversation"
      />,
    );
    await sendViaEnter();

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock.mock.calls[0][0]).toEqual({
      command: 'mstmeetings',
      parentType: 'conversation',
      parentID: 'conv-1',
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends an unregistered /word as a normal message', async () => {
    const onSend = vi.fn();
    render(
      <MessageInput
        onSend={onSend}
        initialBody="/shrug"
        typingParentID="chan-1"
        typingParentType="channel"
      />,
    );
    await sendViaEnter();

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith({ body: '/shrug', attachmentIDs: [] });
  });

  it('sends a command with attachments as a normal message', async () => {
    const onSend = vi.fn();
    render(
      <MessageInput
        onSend={onSend}
        initialBody="/mstmeetings"
        initialDrafts={[{ id: 'att-1', filename: 'a.png', contentType: 'image/png', size: 10 }]}
        typingParentID="chan-1"
        typingParentType="channel"
      />,
    );
    await sendViaEnter();

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith({ body: '/mstmeetings', attachmentIDs: ['att-1'] });
  });

  it('does not intercept in composers without a chat target', async () => {
    // No typingParentID/Type (e.g. an edit box) → commands are disabled and
    // the text goes through onSend untouched.
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} initialBody="/mstmeetings" />);
    await sendViaEnter();

    expect(useCommandsMock).toHaveBeenCalledWith(false);
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith({ body: '/mstmeetings', attachmentIDs: [] });
  });

  it('does not intercept in the thread reply composer', async () => {
    const onSend = vi.fn();
    render(
      <MessageInput
        onSend={onSend}
        initialBody="/mstmeetings"
        typingParentID="chan-1"
        typingParentType="channel"
        typingThreadRootID="root-1"
      />,
    );
    await sendViaEnter();

    expect(useCommandsMock).toHaveBeenCalledWith(false);
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith({ body: '/mstmeetings', attachmentIDs: [] });
  });

  it('shows an inline error when the command fails', async () => {
    runCommandMock.mockImplementation((_input, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.(new Error('boom'));
    });
    render(
      <MessageInput
        onSend={vi.fn()}
        initialBody="/mstmeetings"
        typingParentID="chan-1"
        typingParentType="channel"
      />,
    );
    await sendViaEnter();

    const alert = await screen.findByTestId('command-error');
    expect(alert.textContent).toContain("Couldn't run /mstmeetings");
  });
});
