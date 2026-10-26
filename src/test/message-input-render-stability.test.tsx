import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditorView } from '@codemirror/view';

// The CM6 composer keeps the document as raw markdown — toolbar formatting wraps
// the selection in markdown delimiters rather than producing styled DOM spans.
function editorView(editor: HTMLElement) {
  return EditorView.findFromDOM(editor)!;
}
function editorDoc(editor: HTMLElement) {
  return editorView(editor).state.doc.toString();
}

const mockUploadAttachment = vi.fn();
const mockDeleteDraftMutateAsync = vi.fn().mockResolvedValue(undefined);
const workspaceSettings = vi.hoisted(() => ({
  current: { maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false, giphyAPIKey: '' },
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  useDeleteDraftAttachment: () => ({ mutateAsync: mockDeleteDraftMutateAsync, mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));

const { TestApiError } = vi.hoisted(() => {
  class TestApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return { TestApiError };
});
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: TestApiError,
  getAccessToken: vi.fn(() => null),
  setAccessToken: vi.fn(),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: workspaceSettings.current }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The CM6 composer sources autocomplete data from these hooks — stub them with
// static empty data so their queries don't resolve async outside act().
vi.mock('@/hooks/useConversations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConversations')>()),
  useAllUsers: () => ({ data: [] }),
}));
vi.mock('@/hooks/useChannels', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useChannels')>()),
  useChannelMembers: () => ({ data: [] }),
  useUserChannels: () => ({ data: [] }),
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Count renders of the heavy toolbar children: typing must not re-render them
// once per character (they used to, through callbacks recreated per keystroke).
const renders = vi.hoisted(() => ({ schedule: 0, emoji: 0 }));
vi.mock('@/components/chat/ScheduleSendMenu', () => ({
  ScheduleSendMenu: () => {
    renders.schedule++;
    return <button type="button" aria-label="Schedule message" />;
  },
}));
vi.mock('@/components/EmojiPicker', () => ({
  EmojiPicker: ({ trigger }: { trigger: React.ReactNode }) => {
    renders.emoji++;
    return <>{trigger}</>;
  },
}));

import { MessageInput } from '@/components/chat/MessageInput';

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function type(editor: HTMLElement, text: string) {
  const v = editorView(editor);
  for (const ch of text) {
    act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: ch } }));
  }
}

describe('MessageInput render stability while typing', () => {
  it('re-renders the send/schedule menu and the emoji picker at most once for a typed word, not per character', () => {
    const onSend = vi.fn();
    const { container } = renderWithClient(<MessageInput onSend={onSend} onSchedule={vi.fn()} />);
    const editor = container.querySelector('.cm-content') as HTMLElement;
    expect(editor).not.toBeNull();
    expect(renders.schedule).toBeGreaterThan(0);
    const schedule = renders.schedule;
    const emoji = renders.emoji;

    type(editor, 'hello');
    expect(editorDoc(editor)).toBe('hello');

    // One re-render is the send button turning on (nothing → something to send).
    expect(renders.schedule - schedule).toBeLessThanOrEqual(1);
    expect(renders.emoji - emoji).toBeLessThanOrEqual(1);
  });
});
