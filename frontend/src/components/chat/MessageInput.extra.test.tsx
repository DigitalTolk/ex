import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockUploadAttachment = vi.fn();
const mockDeleteDraftMutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  useDeleteDraftAttachment: () => ({ mutateAsync: mockDeleteDraftMutateAsync, mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageInput } from './MessageInput';

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageInput - file upload', () => {
  it('clicking the attach button triggers the hidden file input', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={vi.fn()} />);

    const attach = screen.getByLabelText('Attach file');
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');

    await user.click(attach);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('shows a draft chip after a successful upload', async () => {
    const init = {
      id: 'att-99',
      uploadURL: 'http://s3/u',
      alreadyExists: false,
      filename: 'pic.png',
      contentType: 'image/png',
      size: 1,
    };
    mockUploadAttachment.mockImplementationOnce(
      async (
        _file: File,
        cb?: { onInit?: (i: typeof init) => void; onProgress?: (n: number) => void },
      ) => {
        cb?.onInit?.(init);
        cb?.onProgress?.(1);
        return init;
      },
    );

    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(screen.getByText('pic.png')).toBeInTheDocument();
    });
  });

  it('shows upload error when upload throws (e.g. PUT failure)', async () => {
    mockUploadAttachment.mockRejectedValueOnce(new Error('Upload failed: 502'));

    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Upload failed: 502/i);
  });

  it('shows error when presign API fails', async () => {
    mockUploadAttachment.mockRejectedValueOnce(new Error('presign failed'));

    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    expect(await screen.findByRole('alert')).toHaveTextContent('presign failed');
  });

  it('does nothing when no file is chosen', () => {
    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { value: [], configurable: true });
    fireEvent.change(fileInput);
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  it('uploads multiple files concurrently and shows a chip for each before any completes', async () => {
    // Hold every upload open until the test releases it. This proves that
    // the orchestration starts uploads in parallel — the second chip
    // must appear (and its progress must update) while the first upload
    // is still pending.
    type Resolvers = {
      release: () => void;
      onInit: (init: { id: string; uploadURL: string; alreadyExists: boolean; filename: string; contentType: string; size: number }) => void;
      onProgress: (n: number) => void;
    };
    const inFlight: Resolvers[] = [];
    mockUploadAttachment.mockImplementation((file: File, cb: { onInit: Resolvers['onInit']; onProgress: Resolvers['onProgress'] }) => {
      return new Promise<void>((resolve) => {
        inFlight.push({
          release: resolve,
          onInit: cb.onInit,
          onProgress: cb.onProgress,
        });
      }).then(() => ({
        id: `att-${file.name}`,
        uploadURL: 'http://s3/u',
        alreadyExists: false,
        filename: file.name,
        contentType: file.type,
        size: file.size,
      }));
    });

    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const fileA = new File(['a'], 'a.png', { type: 'image/png' });
    const fileB = new File(['b'], 'b.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [fileA, fileB], configurable: true });
    fireEvent.change(fileInput);

    // Both chips must render immediately (before any upload completes),
    // and uploadAttachment must have been called twice in parallel —
    // proving uploads are not serialized.
    await waitFor(() => {
      expect(screen.getByText('a.png')).toBeInTheDocument();
      expect(screen.getByText('b.png')).toBeInTheDocument();
    });
    await waitFor(() => expect(inFlight.length).toBe(2));

    // Both uploads still pending — no completion has happened yet.
    // Drive progress on file B while file A is still at 0% to prove the
    // second chip's progress updates without waiting on the first.
    await act(async () => {
      inFlight[0].onInit({
        id: 'att-a.png',
        uploadURL: 'http://s3/u',
        alreadyExists: false,
        filename: 'a.png',
        contentType: 'image/png',
        size: 1,
      });
      inFlight[1].onInit({
        id: 'att-b.png',
        uploadURL: 'http://s3/u',
        alreadyExists: false,
        filename: 'b.png',
        contentType: 'image/png',
        size: 1,
      });
      inFlight[1].onProgress(0.5);
    });

    await waitFor(() => {
      const chips = screen.getAllByTestId('attachment-chip');
      expect(chips).toHaveLength(2);
      const bChip = chips.find((c) => c.textContent?.includes('b.png'));
      expect(bChip).toBeDefined();
      // 50% progress shows on the second chip while the first is still 0%.
      expect(bChip!.textContent).toContain('50%');
    });

    // Release both to let cleanup proceed.
    await act(async () => {
      inFlight[0].release();
      inFlight[1].release();
    });
  });

  it('caps concurrency at 4 so a 5-file drop kicks off only 4 uploads simultaneously', async () => {
    const inFlight: Array<() => void> = [];
    mockUploadAttachment.mockImplementation((file: File) => {
      return new Promise<void>((resolve) => {
        inFlight.push(resolve);
      }).then(() => ({
        id: `att-${file.name}`,
        uploadURL: 'http://s3/u',
        alreadyExists: false,
        filename: file.name,
        contentType: file.type,
        size: file.size,
      }));
    });

    render(<MessageInput onSend={vi.fn()} />);
    const fileInput = screen.getByLabelText('File input') as HTMLInputElement;
    const files = [1, 2, 3, 4, 5].map((i) => new File([String(i)], `f${i}.png`, { type: 'image/png' }));
    Object.defineProperty(fileInput, 'files', { value: files, configurable: true });
    fireEvent.change(fileInput);

    // All 5 chips render up front; only 4 uploads kick off until one finishes.
    await waitFor(() => {
      expect(screen.getAllByTestId('attachment-chip')).toHaveLength(5);
    });
    await waitFor(() => expect(inFlight.length).toBe(4));
    // Give the event loop a tick to potentially fire a 5th — it must not.
    await new Promise((r) => setTimeout(r, 20));
    expect(inFlight.length).toBe(4);

    // Release one — the 5th upload should now start.
    await act(async () => { inFlight[0](); });
    await waitFor(() => expect(inFlight.length).toBe(5));
    await act(async () => { inFlight.slice(1).forEach((r) => r()); });
  });
});
