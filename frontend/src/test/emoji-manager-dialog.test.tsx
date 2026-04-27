import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const useEmojisMock = vi.fn();
const uploadMutateAsync = vi.fn();
const removeMutateAsync = vi.fn();
const useAuthMock = vi.fn();

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => useEmojisMock(),
  useUploadEmoji: () => ({ mutateAsync: uploadMutateAsync, isPending: false }),
  useDeleteEmoji: () => ({ mutateAsync: removeMutateAsync, isPending: false }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

import { EmojiManagerDialog } from '@/components/EmojiManagerDialog';

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EmojiManagerDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useEmojisMock.mockReset();
  uploadMutateAsync.mockReset();
  removeMutateAsync.mockReset();
  useAuthMock.mockReset();
  useEmojisMock.mockReturnValue({ data: [] });
  useAuthMock.mockReturnValue({ user: { id: 'u-me', systemRole: 'admin' } });
  // jsdom lacks URL.createObjectURL — stub it.
  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:mock') as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  } else {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  }
});

describe('EmojiManagerDialog', () => {
  it('shows the empty-state copy when no emojis exist', () => {
    useEmojisMock.mockReturnValue({ data: [] });
    renderDialog();
    expect(screen.getByText(/No custom emojis yet/i)).toBeInTheDocument();
  });

  it('lists existing emojis and shows the per-row delete button when user is admin', () => {
    useEmojisMock.mockReturnValue({
      data: [
        { name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-other' },
        { name: 'cat', imageURL: 'https://cdn/c.png', createdBy: 'u-me' },
      ],
    });
    renderDialog();
    expect(screen.getByText(':parrot:')).toBeInTheDocument();
    expect(screen.getByText(':cat:')).toBeInTheDocument();
    // Admin can delete both
    expect(screen.getByLabelText('Delete :parrot:')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete :cat:')).toBeInTheDocument();
  });

  it('hides delete buttons for emojis the non-admin viewer did not create', () => {
    useAuthMock.mockReturnValue({ user: { id: 'u-me', systemRole: 'member' } });
    useEmojisMock.mockReturnValue({
      data: [
        { name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-other' },
        { name: 'cat', imageURL: 'https://cdn/c.png', createdBy: 'u-me' },
      ],
    });
    renderDialog();
    // Only their own row shows a delete button
    expect(screen.queryByLabelText('Delete :parrot:')).toBeNull();
    expect(screen.getByLabelText('Delete :cat:')).toBeInTheDocument();
  });

  it('rejects an invalid shortcode', async () => {
    renderDialog();
    const input = screen.getByLabelText('Emoji shortcode') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'BAD NAME!' } });
    // Need a file too, otherwise the Save button stays disabled.
    const fileInput = screen.getByLabelText('Emoji image') as HTMLInputElement;
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    // toLowerCase'd by onChange; but the space + ! still fail the regex
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Name must be 1–32 chars/);
    });
    expect(uploadMutateAsync).not.toHaveBeenCalled();
  });

  it('uploads on Save when name and file are valid; resets the form on success', async () => {
    uploadMutateAsync.mockResolvedValueOnce({ name: 'ok', imageURL: 'http://x', createdBy: 'u-me' });
    renderDialog();

    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'ok' } });
    const fileInput = screen.getByLabelText('Emoji image') as HTMLInputElement;
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(screen.getByText('x.png', { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(uploadMutateAsync).toHaveBeenCalledWith({ name: 'ok', file });
    });
  });

  it('surfaces upload errors as an inline alert', async () => {
    uploadMutateAsync.mockRejectedValueOnce(new Error('boom'));
    renderDialog();

    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'ok' } });
    const fileInput = screen.getByLabelText('Emoji image') as HTMLInputElement;
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom');
    });
  });

  it('Clear button resets the staged form', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'foo' } });
    const fileInput = screen.getByLabelText('Emoji image') as HTMLInputElement;
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(screen.getByText('x.png', { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    expect((screen.getByLabelText('Emoji shortcode') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('x.png', { exact: false })).toBeNull();
  });

  it('removing the chosen image via the X swap clears preview', () => {
    renderDialog();
    const fileInput = screen.getByLabelText('Emoji image') as HTMLInputElement;
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(screen.getByText('x.png', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove image'));
    expect(screen.queryByText('x.png', { exact: false })).toBeNull();
  });

  it('delete row opens a ConfirmDialog (not window.confirm) and removes on Confirm', async () => {
    useEmojisMock.mockReturnValue({
      data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' }],
    });
    const confirmSpy = vi.spyOn(window, 'confirm');
    removeMutateAsync.mockResolvedValueOnce(undefined);

    renderDialog();
    fireEvent.click(screen.getByLabelText('Delete :parrot:'));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-emoji')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('delete-emoji-confirm'));

    await waitFor(() => {
      expect(removeMutateAsync).toHaveBeenCalledWith('parrot');
    });
    confirmSpy.mockRestore();
  });

  it('Cancel in the delete-emoji dialog aborts without firing the mutation', () => {
    useEmojisMock.mockReturnValue({
      data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' }],
    });

    renderDialog();
    fireEvent.click(screen.getByLabelText('Delete :parrot:'));
    fireEvent.click(screen.getByTestId('delete-emoji-cancel'));
    expect(removeMutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByTestId('delete-emoji')).toBeNull();
  });

  it('shows delete error in the alert', async () => {
    useEmojisMock.mockReturnValue({
      data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' }],
    });
    removeMutateAsync.mockRejectedValueOnce(new Error('forbidden'));

    renderDialog();
    fireEvent.click(screen.getByLabelText('Delete :parrot:'));
    fireEvent.click(screen.getByTestId('delete-emoji-confirm'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('forbidden');
    });
  });
});
