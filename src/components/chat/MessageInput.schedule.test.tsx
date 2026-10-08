import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MessageInput } from './MessageInput';
import { SCHEDULE_PRESETS } from '@/lib/schedule-times';

vi.mock('@/components/ui/dropdown-menu');
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

// The CM6 composer (MarkdownComposer) sources autocomplete data from these
// hooks. Stub them with static empty data so their queries don't resolve
// asynchronously outside act() during these editor-agnostic tests.
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

// Stub the workspace-settings hook so MessageInput doesn't fire a
// real React Query against the mocked apiFetch — the late resolve
// would land outside act() and warn during focus-event tests.
vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false } }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Same act()-hygiene for the connectors registry query (feeds the "/"
// connector picker in MarkdownComposer).
vi.mock('@/hooks/useConnectors', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConnectors')>()),
  useConnectors: () => ({ data: [] }),
}));

// …and the skills registry query (feeds the "/" skill picker).
vi.mock('@/hooks/useAgents', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useAgents')>()),
  useSkills: () => ({ data: [] }),
}));

// Same act()-hygiene for the slash-command registry query (enabled whenever
// the composer has a chat target, i.e. the typing props are set). Behavior is
// covered in MessageInput.commands.test.tsx.
vi.mock('@/hooks/useCommands', () => ({
  useCommands: () => ({ data: [] }),
  useRunCommand: () => ({ mutate: vi.fn() }),
}));

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}


const tomorrow = SCHEDULE_PRESETS[0].label;

describe('MessageInput — send later', () => {
  it('offers ⌄ beside Send only when scheduling is possible', () => {
    render(<MessageInput onSend={vi.fn()} initialBody="Hi" />);
    expect(screen.queryByTestId('schedule-send-trigger')).toBeNull();
  });

  it('schedules the composed message and clears the composer, like a send', async () => {
    const onSchedule = vi.fn().mockResolvedValue(undefined);
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} onSchedule={onSchedule} initialBody="Standup notes are in the doc" />);
    const editor = await screen.findByLabelText('Message input');
    fireEvent.click(screen.getByTestId('schedule-send-trigger'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText(`Send ${tomorrow}`));
    });
    expect(onSchedule).toHaveBeenCalledWith({ body: 'Standup notes are in the doc', attachmentIDs: [] }, expect.any(Date));
    expect(onSchedule.mock.calls[0][1].getHours()).toBe(9);
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(editor.textContent).toBe(''));
  });

  it('schedules attached files with the text, and lets go of their local previews', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: revoke }));
    const onSchedule = vi.fn().mockResolvedValue(undefined);
    render(
      <MessageInput
        onSend={vi.fn()}
        onSchedule={onSchedule}
        initialBody="See attached"
        initialDrafts={[
          { id: 'att-1', filename: 'plan.pdf', contentType: 'application/pdf', size: 10 },
          { id: 'att-2', filename: 'shot.png', contentType: 'image/png', size: 10, localURL: 'blob:shot' },
        ]}
      />,
    );
    await screen.findByLabelText('Message input');
    await act(async () => {
      fireEvent.click(screen.getByLabelText(`Send ${tomorrow}`));
    });
    expect(onSchedule.mock.calls[0][0]).toEqual({ body: 'See attached', attachmentIDs: ['att-1', 'att-2'] });
    expect(revoke).toHaveBeenCalledWith('blob:shot');
    vi.unstubAllGlobals();
  });

  it('keeps the text when scheduling fails', async () => {
    const onSchedule = vi.fn().mockRejectedValue(new Error('offline'));
    render(<MessageInput onSend={vi.fn()} onSchedule={onSchedule} initialBody="Keep me" />);
    const editor = await screen.findByLabelText('Message input');
    await act(async () => {
      fireEvent.click(screen.getByLabelText(`Send ${tomorrow}`));
    });
    expect(onSchedule).toHaveBeenCalled();
    expect(editor.textContent).toContain('Keep me');
  });

  it('can\'t schedule an empty message', () => {
    render(<MessageInput onSend={vi.fn()} onSchedule={vi.fn()} />);
    expect(screen.getByTestId('schedule-send-trigger')).toBeDisabled();
  });

  it('shows how many messages are scheduled here, linking to them', () => {
    render(<MessageInput onSend={vi.fn()} onSchedule={vi.fn()} scheduledCount={2} />);
    const link = screen.getByTestId('composer-scheduled-link');
    expect(link).toHaveTextContent('2 scheduled');
    expect(link).toHaveAttribute('href', '/drafts?tab=scheduled');
  });
});
