import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const useEmojisMock = vi.fn();
const uploadMutateAsync = vi.fn();
const removeMutateAsync = vi.fn();
const uploadPendingRef = { value: false };
const useAuthMock = vi.fn();

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => useEmojisMock(),
  useUploadEmoji: () => ({ mutateAsync: uploadMutateAsync, isPending: uploadPendingRef.value }),
  useDeleteEmoji: () => ({ mutateAsync: removeMutateAsync, isPending: false }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

import CustomEmojiPage from '@/pages/CustomEmojiPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CustomEmojiPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useEmojisMock.mockReset();
  uploadMutateAsync.mockReset();
  removeMutateAsync.mockReset();
  useAuthMock.mockReset();
  uploadPendingRef.value = false;
  useEmojisMock.mockReturnValue({ data: [] });
  useAuthMock.mockReturnValue({ user: { id: 'u-me', systemRole: 'admin' } });
  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:mock') as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  } else {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  }
});

function chooseFile(name = 'x.png') {
  const fileInput = screen.getByLabelText('Emoji image') as HTMLInputElement;
  const file = new File(['x'], name, { type: 'image/png' });
  fireEvent.change(fileInput, { target: { files: [file] } });
  return file;
}

describe('CustomEmojiPage', () => {
  it('blocks guests from managing emojis', () => {
    useAuthMock.mockReturnValue({ user: { id: 'u-g', systemRole: 'guest' } });
    renderPage();
    expect(screen.getByText(/Guests can't manage custom emojis/i)).toBeInTheDocument();
  });

  it('renders inside the shared page shell with a heading', () => {
    renderPage();
    expect(screen.getByTestId('page-container')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Custom emojis' })).toBeInTheDocument();
  });

  it('shows the empty-state copy when no emojis exist', () => {
    useEmojisMock.mockReturnValue({ data: [] });
    renderPage();
    expect(screen.getByText(/No custom emojis yet/i)).toBeInTheDocument();
  });

  it('shows a (0) count and empty state when the list is undefined', () => {
    useEmojisMock.mockReturnValue({ data: undefined });
    renderPage();
    expect(screen.getByText(/\(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/No custom emojis yet/i)).toBeInTheDocument();
  });

  it('lists existing emojis with per-row delete for an admin', () => {
    useEmojisMock.mockReturnValue({
      data: [
        { name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-other' },
        { name: 'cat', imageURL: 'https://cdn/c.png', createdBy: 'u-me' },
      ],
    });
    renderPage();
    expect(screen.getByText(':parrot:')).toBeInTheDocument();
    expect(screen.getByText(':cat:')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete :parrot:')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete :cat:')).toBeInTheDocument();
  });

  it('hides delete buttons a non-admin viewer did not create', () => {
    useAuthMock.mockReturnValue({ user: { id: 'u-me', systemRole: 'member' } });
    useEmojisMock.mockReturnValue({
      data: [
        { name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-other' },
        { name: 'cat', imageURL: 'https://cdn/c.png', createdBy: 'u-me' },
      ],
    });
    renderPage();
    expect(screen.queryByLabelText('Delete :parrot:')).toBeNull();
    expect(screen.getByLabelText('Delete :cat:')).toBeInTheDocument();
  });

  it('filters the existing list by the search box', () => {
    useEmojisMock.mockReturnValue({
      data: [
        { name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' },
        { name: 'cat', imageURL: 'https://cdn/c.png', createdBy: 'u-me' },
      ],
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('Search custom emojis'), { target: { value: 'par' } });
    expect(screen.getByText(':parrot:')).toBeInTheDocument();
    expect(screen.queryByText(':cat:')).toBeNull();
  });

  it('shows a no-match message when the search filters everything out', () => {
    useEmojisMock.mockReturnValue({
      data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' }],
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('Search custom emojis'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No emojis match your search/i)).toBeInTheDocument();
  });

  it('rejects an invalid shortcode', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'BAD NAME!' } });
    chooseFile();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Name must be 1–32 chars/);
    });
    expect(uploadMutateAsync).not.toHaveBeenCalled();
  });

  it('uploads on Save and resets the form on success', async () => {
    uploadMutateAsync.mockResolvedValueOnce({ name: 'ok' });
    renderPage();
    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'ok' } });
    const file = chooseFile();
    expect(screen.getByText('x.png', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(uploadMutateAsync).toHaveBeenCalledWith({ name: 'ok', file });
    });
    await waitFor(() => {
      expect((screen.getByLabelText('Emoji shortcode') as HTMLInputElement).value).toBe('');
    });
  });

  it('surfaces upload errors as an inline alert', async () => {
    uploadMutateAsync.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'ok' } });
    chooseFile();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom');
    });
  });

  it('falls back to a generic message when upload rejects with a non-Error', async () => {
    uploadMutateAsync.mockRejectedValueOnce('weird');
    renderPage();
    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'ok' } });
    chooseFile();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
    });
  });

  it('shows a pending label and disables Save during upload', () => {
    uploadPendingRef.value = true;
    renderPage();
    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'busy' } });
    chooseFile();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });

  it('Clear resets the staged form', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Emoji shortcode'), { target: { value: 'foo' } });
    chooseFile();
    expect(screen.getByText('x.png', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    expect((screen.getByLabelText('Emoji shortcode') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('x.png', { exact: false })).toBeNull();
  });

  it('removing the chosen image via the X clears the preview', () => {
    renderPage();
    chooseFile();
    expect(screen.getByText('x.png', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove image'));
    expect(screen.queryByText('x.png', { exact: false })).toBeNull();
  });

  it('ignores a file-input change with no file', () => {
    renderPage();
    const fileInput = screen.getByLabelText('Emoji image') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [] } });
    expect(screen.queryByLabelText('Remove image')).toBeNull();
  });

  it('deletes an emoji through the confirm dialog', async () => {
    useEmojisMock.mockReturnValue({
      data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' }],
    });
    removeMutateAsync.mockResolvedValueOnce(undefined);
    renderPage();
    fireEvent.click(screen.getByLabelText('Delete :parrot:'));
    expect(screen.getByTestId('delete-emoji')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('delete-emoji-confirm'));
    await waitFor(() => {
      expect(removeMutateAsync).toHaveBeenCalledWith('parrot');
    });
  });

  it('cancel in the delete dialog aborts without firing the mutation', () => {
    useEmojisMock.mockReturnValue({
      data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' }],
    });
    renderPage();
    fireEvent.click(screen.getByLabelText('Delete :parrot:'));
    fireEvent.click(screen.getByTestId('delete-emoji-cancel'));
    expect(removeMutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByTestId('delete-emoji')).toBeNull();
  });

  it('shows delete errors in the alert', async () => {
    useEmojisMock.mockReturnValue({
      data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' }],
    });
    removeMutateAsync.mockRejectedValueOnce(new Error('forbidden'));
    renderPage();
    fireEvent.click(screen.getByLabelText('Delete :parrot:'));
    fireEvent.click(screen.getByTestId('delete-emoji-confirm'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('forbidden');
    });
  });

  it('falls back to a generic message when delete rejects with a non-Error', async () => {
    useEmojisMock.mockReturnValue({
      data: [{ name: 'parrot', imageURL: 'https://cdn/p.gif', createdBy: 'u-me' }],
    });
    removeMutateAsync.mockRejectedValueOnce('weird');
    renderPage();
    fireEvent.click(screen.getByLabelText('Delete :parrot:'));
    fireEvent.click(screen.getByTestId('delete-emoji-confirm'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Delete failed');
    });
  });
});
