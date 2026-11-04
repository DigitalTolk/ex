import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

// A Word, Excel or PowerPoint file picked in a private channel goes to the
// user's OneDrive and into the message as its link; anything else, or any
// refusal, is attached the ordinary way.

const mockUploadAttachment = vi.fn();
const mockPutOfficeFile = vi.fn();
let authProvider: 'oidc' | 'guest' | null = 'oidc';

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('@/lib/office-upload', async (orig) => ({
  ...(await orig<typeof import('@/lib/office-upload')>()),
  putOfficeFile: (...args: unknown[]) => mockPutOfficeFile(...args),
}));
vi.mock('@/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: authProvider ? { id: 'u-1', authProvider } : null }),
}));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/hooks/useConversations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConversations')>()),
  useAllUsers: () => ({ data: [] }),
}));
vi.mock('@/hooks/useChannels', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useChannels')>()),
  useChannelMembers: () => ({ data: [] }),
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageInput } from '@/components/chat/MessageInput';

const ONE_DRIVE_URL = 'https://contoso-my.sharepoint.com/personal/u1/Q3%20plan.docx';

function renderComposer({ parentType = 'channel', parentID = 'ch-deal' }: { parentType?: 'channel' | 'conversation'; parentID?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(queryKeys.workspaceSettings(), { sharePointHosts: ['*.sharepoint.com'] });
  qc.setQueryData(queryKeys.userChannels(), [
    { channelID: 'ch-deal', channelName: 'deal-room', channelType: 'private' },
    { channelID: 'ch-open', channelName: 'general', channelType: 'public' },
  ]);
  const onSend = vi.fn();
  const view = rtlRender(
    <QueryClientProvider client={qc}>
      <MessageInput onSend={onSend} typingParentID={parentID} typingParentType={parentType} />
    </QueryClientProvider>,
  );
  return { onSend, unmount: view.unmount };
}

function pick(...files: File[]) {
  fireEvent.change(screen.getByLabelText('File input'), { target: { files } });
}

const docx = () => new File(['hello'], 'Q3 plan.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

function attachedAs(id: string) {
  mockUploadAttachment.mockImplementation(async (file: File, cb?: { onInit?: (i: object) => void; onProgress?: (n: number) => void }) => {
    const init = { id, filename: file.name, contentType: file.type, size: file.size, alreadyExists: false };
    cb?.onInit?.(init);
    cb?.onProgress?.(1);
    return init;
  });
}

describe('MessageInput - Office files in a private channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authProvider = 'oidc';
  });

  it('puts the file in OneDrive and its link in the message, with no attachment', async () => {
    mockPutOfficeFile.mockImplementation(async (_ch: string, _f: File, onProgress: (n: number) => void) => {
      onProgress(0.5);
      return { name: 'Q3 plan.docx', webURL: ONE_DRIVE_URL, size: 5 };
    });
    const { onSend } = renderComposer();
    const file = docx();
    pick(file);
    await waitFor(() => expect(mockPutOfficeFile).toHaveBeenCalledWith('ch-deal', file, expect.any(Function)));
    // The chip shows while it goes up, then gives way to the link.
    await waitFor(() => expect(screen.queryByText('Q3 plan.docx')).toBeNull());
    fireEvent.click(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ body: `[Q3 plan.docx](${ONE_DRIVE_URL})`, attachmentIDs: [] }));
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  // The chat was left while the file went up: it is in OneDrive, and there is
  // no message left to put its link in.
  it('lets a file finish going up after the composer is gone', async () => {
    let finish!: (v: unknown) => void;
    mockPutOfficeFile.mockReturnValue(new Promise((r) => { finish = r; }));
    const { unmount } = renderComposer();
    pick(docx());
    await waitFor(() => expect(mockPutOfficeFile).toHaveBeenCalled());
    unmount();
    await act(async () => finish({ name: 'Q3 plan.docx', webURL: ONE_DRIVE_URL, size: 5 }));
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  it('attaches the other files picked with it the ordinary way', async () => {
    mockPutOfficeFile.mockResolvedValue({ name: 'Q3 plan.docx', webURL: ONE_DRIVE_URL, size: 5 });
    attachedAs('att-notes');
    const { onSend } = renderComposer();
    pick(docx(), new File(['n'], 'notes.txt', { type: 'text/plain' }));
    await screen.findByText('notes.txt');
    await waitFor(() => expect(screen.queryByText('Q3 plan.docx')).toBeNull());
    fireEvent.click(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ body: `[Q3 plan.docx](${ONE_DRIVE_URL})`, attachmentIDs: ['att-notes'] }));
    expect(mockPutOfficeFile).toHaveBeenCalledTimes(1);
  });

  it('attaches the file instead when OneDrive refuses it', async () => {
    mockPutOfficeFile.mockRejectedValue(new Error('OneDrive upload refused (409)'));
    attachedAs('att-docx');
    const { onSend } = renderComposer();
    const file = docx();
    pick(file);
    await waitFor(() => expect(mockUploadAttachment).toHaveBeenCalledWith(file, expect.anything()));
    expect(await screen.findByText('Q3 plan.docx')).toBeInTheDocument();
    fireEvent.click(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ body: '', attachmentIDs: ['att-docx'] }));
  });

  it.each([
    ['a guest', () => { authProvider = 'guest'; }, {}],
    ['someone signed out', () => { authProvider = null; }, {}],
    ['a public channel', () => {}, { parentID: 'ch-open' }],
    ['a direct message', () => {}, { parentType: 'conversation' as const, parentID: 'dm-1' }],
  ])('attaches it without asking OneDrive for %s', async (_name, setup, where) => {
    setup();
    attachedAs('att-docx');
    renderComposer(where);
    pick(docx());
    await waitFor(() => expect(mockUploadAttachment).toHaveBeenCalled());
    expect(mockPutOfficeFile).not.toHaveBeenCalled();
  });
});
