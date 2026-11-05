import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditorView } from '@codemirror/view';
import { queryKeys } from '@/lib/query-keys';

// A Word, Excel or PowerPoint file picked in a channel or a DM goes to the
// user's OneDrive and into the message as its link; anything else, or any
// refusal, is attached the ordinary way.

const mockUploadAttachment = vi.fn();
const mockPutOfficeFile = vi.fn();
const mockDeleteDraft = vi.fn();
let authProvider: 'oidc' | 'guest' | null = 'oidc';

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  useDeleteDraftAttachment: () => ({ mutateAsync: mockDeleteDraft, mutate: vi.fn(), isPending: false }),
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
  const onDraftChange = vi.fn();
  const view = rtlRender(
    <QueryClientProvider client={qc}>
      <MessageInput onSend={onSend} onDraftChange={onDraftChange} typingParentID={parentID} typingParentType={parentType} />
    </QueryClientProvider>,
  );
  return { onSend, onDraftChange, unmount: view.unmount };
}

function editorText() {
  return EditorView.findFromDOM(document.querySelector('.cm-content') as HTMLElement)!.state.doc.toString();
}

function typeInto(text: string) {
  const v = EditorView.findFromDOM(document.querySelector('.cm-content') as HTMLElement)!;
  act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: text } }));
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

describe('MessageInput - Office files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authProvider = 'oidc';
  });

  it('puts the file in OneDrive, keeps its chip, and sends its link instead of an attachment', async () => {
    let progress!: (n: number) => void;
    let finish!: (v: unknown) => void;
    mockPutOfficeFile.mockImplementation((_ch: string, _f: File, onProgress: (n: number) => void) => {
      progress = onProgress;
      return new Promise((r) => { finish = r; });
    });
    const { onSend } = renderComposer();
    const file = docx();
    pick(file);
    await waitFor(() => expect(mockPutOfficeFile).toHaveBeenCalledWith({ type: 'channel', id: 'ch-deal' }, file, expect.any(Function)));
    // The chip shows where it is going, and how far along.
    act(() => progress(0.5));
    const bar = await screen.findByRole('progressbar', { name: 'Uploading Q3 plan.docx to OneDrive' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText(/to OneDrive/)).toBeInTheDocument();
    // Every byte sent isn't the file in OneDrive: it stays short of done
    // until the link is back.
    act(() => progress(1));
    expect(bar).toHaveAttribute('aria-valuenow', '99');
    // Then the chip says it is there, and the text stays the user's: the
    // link joins the message only as it goes.
    await act(async () => finish({ name: 'Q3 plan.docx', webURL: ONE_DRIVE_URL, size: 5 }));
    expect(await screen.findByText(/in OneDrive/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Q3 plan.docx')).toBeInTheDocument();
    expect(editorText()).toBe('');
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
    await screen.findByText(/in OneDrive/);
    fireEvent.click(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ body: `[Q3 plan.docx](${ONE_DRIVE_URL})`, attachmentIDs: ['att-notes'] }));
    expect(mockPutOfficeFile).toHaveBeenCalledTimes(1);
  });

  it('sends the link after what was typed', async () => {
    mockPutOfficeFile.mockResolvedValue({ name: 'Q3 plan.docx', webURL: ONE_DRIVE_URL, size: 5 });
    const { onSend } = renderComposer();
    typeInto('here is the plan');
    pick(docx());
    await screen.findByText(/in OneDrive/);
    fireEvent.click(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ body: `here is the plan\n[Q3 plan.docx](${ONE_DRIVE_URL})`, attachmentIDs: [] }));
  });

  // Removing the chip takes the link out of the message; the file is the
  // user's own, in their OneDrive, and nothing in ex is deleted.
  it('drops the link when its chip is removed', async () => {
    mockPutOfficeFile.mockResolvedValue({ name: 'Q3 plan.docx', webURL: ONE_DRIVE_URL, size: 5 });
    const { onSend } = renderComposer();
    typeInto('never mind');
    pick(docx());
    await screen.findByText(/in OneDrive/);
    fireEvent.click(screen.getByLabelText('Remove Q3 plan.docx'));
    expect(screen.queryByText('Q3 plan.docx')).toBeNull();
    expect(mockDeleteDraft).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ body: 'never mind', attachmentIDs: [] }));
  });

  // The draft keeps the link in its text, so leaving the channel before
  // sending loses nothing.
  it('saves the link with the draft', async () => {
    mockPutOfficeFile.mockResolvedValue({ name: 'Q3 plan.docx', webURL: ONE_DRIVE_URL, size: 5 });
    const { onDraftChange } = renderComposer();
    pick(docx());
    await screen.findByText(/in OneDrive/);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(onDraftChange).toHaveBeenLastCalledWith({ body: `[Q3 plan.docx](${ONE_DRIVE_URL})`, attachmentIDs: [] }, expect.anything());
  });

  // Picked with another file, whose chip it leaves alone.
  it('attaches the file instead when OneDrive refuses it', async () => {
    mockPutOfficeFile.mockRejectedValue(new Error('OneDrive upload refused (409)'));
    mockUploadAttachment.mockImplementation(async (f: File, cb?: { onInit?: (i: object) => void }) => {
      const init = { id: `att-${f.name}`, filename: f.name, contentType: f.type, size: f.size, alreadyExists: true };
      cb?.onInit?.(init);
      return init;
    });
    const { onSend } = renderComposer();
    const file = docx();
    pick(file, new File(['n'], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(mockUploadAttachment).toHaveBeenCalledWith(file, expect.anything()));
    expect(await screen.findByText('Q3 plan.docx')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.queryByText(/to OneDrive/)).toBeNull();
    fireEvent.click(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ body: '', attachmentIDs: ['att-Q3 plan.docx', 'att-notes.txt'] }));
  });

  it.each([
    ['a guest', () => { authProvider = 'guest'; }, {}],
    ['someone signed out', () => { authProvider = null; }, {}],
  ])('attaches it without asking OneDrive for %s', async (_name, setup, where) => {
    setup();
    attachedAs('att-docx');
    renderComposer(where);
    pick(docx());
    await waitFor(() => expect(mockUploadAttachment).toHaveBeenCalled());
    expect(mockPutOfficeFile).not.toHaveBeenCalled();
  });

  // A public channel's or a DM's files go to OneDrive too: the link shares
  // the file with the members as a posted link does.
  it.each([
    ['a public channel', { parentID: 'ch-open' }, { type: 'channel', id: 'ch-open' }],
    ['a direct message', { parentType: 'conversation' as const, parentID: 'dm-1' }, { type: 'conversation', id: 'dm-1' }],
  ])('puts the file in OneDrive in %s', async (_name, where, parent) => {
    mockPutOfficeFile.mockResolvedValue({ name: 'Q3 plan.docx', webURL: ONE_DRIVE_URL, size: 5 });
    const { onSend } = renderComposer(where);
    const file = docx();
    pick(file);
    await screen.findByText(/in OneDrive/);
    expect(mockPutOfficeFile).toHaveBeenCalledWith(parent, file, expect.any(Function));
    fireEvent.click(await screen.findByLabelText('Send message'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ body: `[Q3 plan.docx](${ONE_DRIVE_URL})`, attachmentIDs: [] }));
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });
});
