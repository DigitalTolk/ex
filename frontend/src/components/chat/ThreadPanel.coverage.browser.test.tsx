import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadPanel } from './ThreadPanel';
import type { Message } from '@/types';

// Branch-coverage focused tests for ThreadPanel: the follow/unfollow
// onClick branch, merged-user-map (extras), reply send (with and
// without a saved draft), draft-change save, mobile edit-mode lifecycle
// (edit attachments + handleEditMessage same/changed/empty arms), and
// the deep-link anchor effect. MessageInput is replaced with a thin
// double exposing buttons that invoke its callbacks, so the panel's own
// handler branches run without driving the real Wysiwyg editor.

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
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

// MessageInput double — surfaces the wiring the panel passes down so we
// can fire onSend/onCancel/onDraftChange/uploadFiles from the test.
interface InputDoubleProps {
  onSend: (v: { body: string; attachmentIDs?: string[] }) => void;
  onCancel?: () => void;
  onDraftChange?: (v: { body: string; attachmentIDs?: string[] }, options?: { notify?: boolean }) => void;
  placeholder?: string;
  submitLabel?: string;
  initialBody?: string;
  disabled?: boolean;
}
let lastInputProps: InputDoubleProps | null = null;
vi.mock('./MessageInput', () => ({
  MessageInput: (props: InputDoubleProps) => {
    lastInputProps = props;
    return (
      <div data-testid="message-input" data-placeholder={props.placeholder} data-submit={props.submitLabel}>
        <button data-testid="mi-send" onClick={() => props.onSend({ body: 'hello body', attachmentIDs: [] })}>
          send
        </button>
        <button data-testid="mi-send-empty" onClick={() => props.onSend({ body: '   ', attachmentIDs: [] })}>
          send-empty
        </button>
        <button
          data-testid="mi-draft"
          onClick={() => props.onDraftChange?.({ body: 'draft text', attachmentIDs: [] })}
        >
          draft
        </button>
        <button
          data-testid="mi-draft-noatt"
          onClick={() => props.onDraftChange?.({ body: 'draft no attachments' } as { body: string })}
        >
          draft-no-att
        </button>
        <button
          data-testid="mi-draft-notify"
          onClick={() => props.onDraftChange?.({ body: 'draft text', attachmentIDs: [] }, { notify: true })}
        >
          draft-notify
        </button>
        <button
          data-testid="mi-send-noatt"
          onClick={() => props.onSend({ body: 'edited no attachments' } as { body: string })}
        >
          send-no-att
        </button>
        <button data-testid="mi-cancel" onClick={() => props.onCancel?.()}>
          cancel
        </button>
      </div>
    );
  },
}));

vi.mock('@/hooks/useEmoji', () => ({ useEmojis: () => ({ data: [] }), useEmojiMap: () => ({ data: {} }), useFrequentEmojis: () => ['thumbsup', 'heart', 'tada'] }));

let usersBatchData: Array<{ id: string; displayName: string; avatarURL?: string }> = [];
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ data: usersBatchData }),
}));

let isMobileValue = false;
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileValue,
}));

let editAttachmentsState: { map: Map<string, unknown>; isLoading: boolean } = { map: new Map(), isLoading: false };
vi.mock('@/hooks/useAttachments', () => ({
  useAttachmentsBatch: () => editAttachmentsState,
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), mutate: vi.fn(), isPending: false }),
  uploadAttachment: vi.fn(),
}));

const editMessageMutate = vi.fn();
const sendMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: editMessageMutate, isPending: false }),
  useSendMessage: () => ({ mutate: sendMutate, isPending: false }),
}));

let threadMessagesState: { data: unknown; isLoading: boolean } = { data: undefined, isLoading: false };
const followThreadMutate = vi.fn();
const unfollowThreadMutate = vi.fn();
let userThreadsData: Array<{ parentID: string; parentType: 'channel' | 'conversation'; threadRootID: string }> = [];
vi.mock('@/hooks/useThreads', () => ({
  useUserThreads: () => ({ data: userThreadsData }),
  useThreadMessages: () => threadMessagesState,
  useFollowThread: () => ({ mutate: followThreadMutate, isPending: false }),
  useUnfollowThread: () => ({ mutate: unfollowThreadMutate, isPending: false }),
  markThreadSeen: vi.fn(),
}));

let draftState: { data: { id?: string; body?: string; attachmentIDs?: string[] } | undefined } = { data: undefined };
const saveDraftMutate = vi.fn();
const deleteDraftMutate = vi.fn();
const restoreDraftScopeForContentMock = vi.fn();
const suppressSentDraftMock = vi.fn();
const restoreDraftScopeMock = vi.fn();
vi.mock('@/hooks/useDrafts', () => ({
  useDraftForScope: () => draftState,
  useDraftAttachmentChips: () => [],
  useSaveDraft: () => ({ mutate: saveDraftMutate }),
  useDeleteDraft: () => ({ mutate: deleteDraftMutate }),
  restoreDraftScope: (...a: unknown[]) => restoreDraftScopeMock(...a),
  restoreDraftScopeForContent: (...a: unknown[]) => restoreDraftScopeForContentMock(...a),
  suppressSentDraft: (...a: unknown[]) => suppressSentDraftMock(...a),
}));

vi.mock('./TypingIndicator', () => ({
  ThreadTypingIndicator: () => <div data-testid="typing-indicator" />,
}));

vi.mock('./MessageItem', () => ({
  MessageItem: ({ message, onEditMessage }: { message: Message; onEditMessage?: (m: Message) => void }) => (
    // The real MessageItem renders id="msg-<id>" — the ThreadPanel anchor
    // effect resolves the scroll target via getElementById, so the double
    // must reproduce that id.
    <div id={`msg-${message.id}`} data-message-id={message.id} style={{ height: 64 }}>
      <span>{message.body}</span>
      {onEditMessage ? (
        <button data-testid={`edit-${message.id}`} onClick={() => onEditMessage(message)}>
          edit
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('./MessageDropZone', () => ({
  MessageDropZone: ({ children }: { children: React.ReactNode }) => <div data-testid="drop-zone">{children}</div>,
}));

function rootMsg(over: Partial<Message> = {}): Message {
  return {
    id: 'ROOT',
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body: 'thread root',
    createdAt: '2026-05-01T10:00:00Z',
    ...over,
  };
}

function reply(id: string, body: string, over: Partial<Message> = {}): Message {
  return {
    id,
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body,
    parentMessageID: 'ROOT',
    createdAt: '2026-05-01T11:00:00Z',
    ...over,
  };
}

function mount(props: Partial<Parameters<typeof ThreadPanel>[0]> = {}) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(() => Promise.resolve(null));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ThreadPanel
          channelId="ch-1"
          threadRootID="ROOT"
          onClose={vi.fn()}
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          currentUserId="u-1"
          {...props}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  lastInputProps = null;
  usersBatchData = [];
  isMobileValue = false;
  editAttachmentsState = { map: new Map(), isLoading: false };
  threadMessagesState = { data: [rootMsg(), reply('R1', 'a reply')], isLoading: false };
  userThreadsData = [];
  draftState = { data: undefined };
  editMessageMutate.mockReset();
  sendMutate.mockReset();
  followThreadMutate.mockReset();
  unfollowThreadMutate.mockReset();
  saveDraftMutate.mockReset();
  deleteDraftMutate.mockReset();
  restoreDraftScopeForContentMock.mockReset();
  suppressSentDraftMock.mockReset();
  restoreDraftScopeMock.mockReset();
});

describe('ThreadPanel coverage — follow / unfollow', () => {
  it('follows a thread when not currently following', async () => {
    userThreadsData = [];
    const screen = await mount();
    await screen.getByRole('button', { name: 'Follow thread' }).click();
    expect(followThreadMutate).toHaveBeenCalledWith({ parentID: 'ch-1', parentType: 'channel', threadRootID: 'ROOT' });
    expect(unfollowThreadMutate).not.toHaveBeenCalled();
  });

  it('unfollows a thread when already following', async () => {
    userThreadsData = [{ parentID: 'ch-1', parentType: 'channel', threadRootID: 'ROOT' }];
    const screen = await mount();
    await screen.getByRole('button', { name: 'Unfollow thread' }).click();
    expect(unfollowThreadMutate).toHaveBeenCalledWith({ parentID: 'ch-1', parentType: 'channel', threadRootID: 'ROOT' });
    expect(followThreadMutate).not.toHaveBeenCalled();
  });
});

describe('ThreadPanel coverage — merged user map', () => {
  it('merges extra users fetched for authors missing from the parent userMap', async () => {
    // useUsersBatch returns an author not present in userMap → mergedUserMap
    // augments it (lines 73-76, including the `displayName || "Unknown"`
    // fallback for an empty display name).
    threadMessagesState = {
      data: [rootMsg(), reply('R-bob', 'bob reply', { authorID: 'u-bob' })],
      isLoading: false,
    };
    usersBatchData = [
      { id: 'u-bob', displayName: 'Bob', avatarURL: 'http://x/bob.png' },
      { id: 'u-empty', displayName: '' },
    ];
    const screen = await mount();
    await expect.element(screen.getByText('bob reply')).toBeVisible();
  });
});

describe('ThreadPanel coverage — reply send', () => {
  it('sends a reply with no existing draft (no draftID delete path)', async () => {
    draftState = { data: undefined };
    const screen = await mount();
    await screen.getByTestId('mi-send').click();
    expect(suppressSentDraftMock).toHaveBeenCalled();
    expect(sendMutate).toHaveBeenCalled();
    // No draftID → the no-draft branch fired; the onSuccess/onError config
    // passed to send.mutate has no deleteDraft callback.
    const call = sendMutate.mock.calls[0];
    expect(call[0].parentMessageID).toBe('ROOT');
  });

  it('sends a reply that clears an existing saved draft on success', async () => {
    draftState = { data: { id: 'draft-9', body: 'saved' } };
    const screen = await mount();
    await screen.getByTestId('mi-send').click();
    expect(sendMutate).toHaveBeenCalled();
    // Invoke the onSuccess handler the panel passed to send.mutate → it
    // deletes the saved draft (line 360).
    const options = sendMutate.mock.calls[0][1] as { onSuccess?: () => void; onError?: () => void };
    options.onSuccess?.();
    expect(deleteDraftMutate).toHaveBeenCalledWith('draft-9');
    // The onError path restores the suppressed draft scope.
    options.onError?.();
    expect(restoreDraftScopeMock).toHaveBeenCalled();
  });

  it('restores the draft scope when a no-draft reply errors', async () => {
    draftState = { data: undefined };
    const screen = await mount();
    await screen.getByTestId('mi-send').click();
    const options = sendMutate.mock.calls[0][1] as { onError?: () => void };
    options.onError?.();
    expect(restoreDraftScopeMock).toHaveBeenCalled();
  });
});

describe('ThreadPanel coverage — draft change', () => {
  it('persists a keystroke draft change SILENTLY so the indicator stays hidden', async () => {
    const screen = await mount();
    await screen.getByTestId('mi-draft').click();
    expect(restoreDraftScopeForContentMock).toHaveBeenCalled();
    expect(saveDraftMutate).toHaveBeenCalledWith({
      parentID: 'ch-1',
      parentType: 'channel',
      parentMessageID: 'ROOT',
      body: 'draft text',
      attachmentIDs: [],
      silent: true,
    });
  });

  it('surfaces the draft (silent=false) on a focus-loss flush (notify)', async () => {
    const screen = await mount();
    await screen.getByTestId('mi-draft-notify').click();
    expect(saveDraftMutate).toHaveBeenCalledWith({
      parentID: 'ch-1',
      parentType: 'channel',
      parentMessageID: 'ROOT',
      body: 'draft text',
      attachmentIDs: [],
      silent: false,
    });
  });

  it('defaults attachmentIDs to [] when a draft change omits them', async () => {
    // onDraftChange payload without attachmentIDs → handleDraftChange's
    // `value.attachmentIDs ?? []` nullish arm (line 345).
    const screen = await mount();
    await screen.getByTestId('mi-draft-noatt').click();
    expect(saveDraftMutate).toHaveBeenCalledWith({
      parentID: 'ch-1',
      parentType: 'channel',
      parentMessageID: 'ROOT',
      body: 'draft no attachments',
      attachmentIDs: [],
      silent: true,
    });
  });
});

describe('ThreadPanel coverage — edit attachmentIDs default', () => {
  it('defaults the edited attachmentIDs to [] when the payload omits them', async () => {
    isMobileValue = true;
    threadMessagesState = {
      data: [rootMsg(), reply('R1', 'original body', { attachmentIDs: ['a-prev'] })],
      isLoading: false,
    };
    const screen = await mount();
    await screen.getByTestId('edit-R1').click();
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBe('Save');
    });
    // Submit an edit whose payload omits attachmentIDs → handleEditMessage's
    // `value.attachmentIDs ?? []` nullish arm (line 371). Body changed and the
    // attachment count differs from the original → it mutates.
    await screen.getByTestId('mi-send-noatt').click();
    expect(editMessageMutate).toHaveBeenCalled();
    const vars = editMessageMutate.mock.calls[0][0];
    expect(vars.attachmentIDs).toEqual([]);
  });
});

describe('ThreadPanel coverage — mobile edit mode', () => {
  it('enters edit mode and saves a changed message', async () => {
    isMobileValue = true;
    threadMessagesState = {
      data: [rootMsg(), reply('R1', 'editable reply')],
      isLoading: false,
    };
    const screen = await mount();
    await screen.getByTestId('edit-R1').click();
    // The composer switched to edit mode: Save submit label + edit placeholder.
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBe('Save');
    });
    await screen.getByTestId('mi-send').click();
    // Body changed ('hello body' vs 'editable reply') → editMessage.mutate fires.
    expect(editMessageMutate).toHaveBeenCalled();
    const vars = editMessageMutate.mock.calls[0][0];
    expect(vars.messageId).toBe('R1');
    expect(vars.body).toBe('hello body');
    // Invoke the onSuccess that closes edit mode.
    const opts = editMessageMutate.mock.calls[0][1] as { onSuccess?: () => void };
    opts.onSuccess?.();
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBeUndefined();
    });
  });

  it('closes edit mode without mutating when the edit is unchanged', async () => {
    isMobileValue = true;
    threadMessagesState = {
      data: [rootMsg(), reply('R1', 'hello body')],
      isLoading: false,
    };
    const screen = await mount();
    await screen.getByTestId('edit-R1').click();
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBe('Save');
    });
    // Sends the SAME body 'hello body' → `same` true → no mutate, just close.
    await screen.getByTestId('mi-send').click();
    expect(editMessageMutate).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBeUndefined();
    });
  });

  it('closes edit mode without mutating when the edited body is blank', async () => {
    isMobileValue = true;
    threadMessagesState = {
      data: [rootMsg(), reply('R1', 'original')],
      isLoading: false,
    };
    const screen = await mount();
    await screen.getByTestId('edit-R1').click();
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBe('Save');
    });
    // 'send-empty' submits a whitespace-only body with no attachments →
    // `!value.body.trim() && nextAttachmentIDs.length === 0` → close, no mutate.
    await screen.getByTestId('mi-send-empty').click();
    expect(editMessageMutate).not.toHaveBeenCalled();
  });

  it('cancels edit mode via the composer cancel button', async () => {
    isMobileValue = true;
    threadMessagesState = { data: [rootMsg(), reply('R1', 'reply')], isLoading: false };
    const screen = await mount();
    await screen.getByTestId('edit-R1').click();
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBe('Save');
    });
    await screen.getByTestId('mi-cancel').click();
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBeUndefined();
    });
  });

  it('shows the editor-loading placeholder while edit attachments are still loading', async () => {
    isMobileValue = true;
    editAttachmentsState = { map: new Map(), isLoading: true };
    threadMessagesState = {
      data: [rootMsg(), reply('R1', 'reply', { attachmentIDs: ['a-1'] })],
      isLoading: false,
    };
    const screen = await mount();
    await screen.getByTestId('edit-R1').click();
    await expect.element(screen.getByText('Loading message editor...')).toBeVisible();
  });

  it('builds edit draft attachments from resolved attachment metadata', async () => {
    isMobileValue = true;
    editAttachmentsState = {
      map: new Map([
        [
          'a-1',
          {
            id: 'a-1',
            filename: 'pic.png',
            contentType: 'image/png',
            size: 10,
            url: 'blob:pic',
            squareThumbnailURL: 'blob:thumb',
          },
        ],
      ]),
      isLoading: false,
    };
    threadMessagesState = {
      data: [rootMsg(), reply('R1', 'reply', { attachmentIDs: ['a-1', 'a-missing'] })],
      isLoading: false,
    };
    const screen = await mount();
    await screen.getByTestId('edit-R1').click();
    // Composer renders in edit mode (a-1 resolved → chip; a-missing → null).
    await vi.waitFor(() => {
      expect(lastInputProps?.submitLabel).toBe('Save');
    });
  });
});

describe('ThreadPanel coverage — deep-link anchor', () => {
  it('scrolls to and highlights the anchored reply', async () => {
    threadMessagesState = {
      data: [rootMsg(), reply('R-anchor', 'anchored reply'), reply('R-after', 'after')],
      isLoading: false,
    };
    const screen = await mount({ anchorMsgId: 'R-anchor', anchorRevision: 'rev-1' });
    await expect.element(screen.getByText('anchored reply')).toBeVisible();
    // The cosmetic highlight effect adds the ring classes to the anchored
    // element (lines 295-299).
    await vi.waitFor(() => {
      const el = document.getElementById('msg-R-anchor');
      expect(el?.classList.contains('ring-1')).toBe(true);
    }, { timeout: 3000 });
  });

  it('scrolls to the anchor when no anchorRevision is supplied', async () => {
    threadMessagesState = {
      data: [rootMsg(), reply('R-na', 'anchored no-rev'), reply('R-after', 'after')],
      isLoading: false,
    };
    const screen = await mount({ anchorMsgId: 'R-na' });
    await expect.element(screen.getByText('anchored no-rev')).toBeVisible();
    await vi.waitFor(() => {
      const el = document.getElementById('msg-R-na');
      expect(el?.classList.contains('ring-1')).toBe(true);
    }, { timeout: 3000 });
  });
});
