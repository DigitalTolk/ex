import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditProfileDialog } from './EditProfileDialog';
import { ThemeProvider } from '@/context/ThemeContext';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const mockSetAuth = vi.fn();
const mockUser = {
  id: 'u-1',
  email: 'alice@test.com',
  displayName: 'Alice',
  avatarURL: 'https://example.com/avatar.png',
  systemRole: 'member' as const,
  status: 'active',
};

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: mockSetAuth,
  }),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  getAccessToken: () => 'test-token',
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EditProfileDialog', () => {
  it('renders profile fields when open', () => {
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
    expect(screen.getByDisplayValue('alice@test.com')).toBeInTheDocument();
  });

  it('email input is read-only', () => {
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    const emailInput = screen.getByLabelText('Email') as HTMLInputElement;
    expect(emailInput.readOnly).toBe(true);
  });

  it('does not render when closed', () => {
    renderWithTheme(<EditProfileDialog open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  });

  it('cancel closes the dialog', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={onOpenChange} />);

    await user.click(screen.getByText('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('saves display name when changed', async () => {
    mockApiFetch.mockResolvedValueOnce({ ...mockUser, displayName: 'Alice Updated' });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={onOpenChange} />);

    const nameInput = screen.getByLabelText('Display name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Alice Updated');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/users/me',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ displayName: 'Alice Updated' }),
        }),
      );
    });
    expect(mockSetAuth).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not call API when nothing changed', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={onOpenChange} />);

    await user.click(screen.getByText('Save'));

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('rejects invalid file types', async () => {
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    // Get the hidden file input.
    const fileInputs = document.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBeGreaterThan(0);
    const fileInput = fileInputs[0] as HTMLInputElement;

    const badFile = new File(['fake'], 'test.gif', { type: 'image/gif' });
    fireEvent.change(fileInput, { target: { files: [badFile] } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/JPEG, PNG, or WebP/i);
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('rejects files larger than 2MB', async () => {
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const fileInput = fileInputs[0] as HTMLInputElement;

    // Create a fake file ~3MB
    const big = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [big] } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/2MB/i);
    });
  });

  it('uploads avatar via presigned URL flow', async () => {
    // Mock fetch (used directly for the S3 PUT)
    const realFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch as unknown as typeof fetch;

    // 1st call: backend returns presigned URL.
    mockApiFetch.mockResolvedValueOnce({
      uploadURL: 'http://localhost:9000/bucket/key?signature=xyz',
      key: 'avatars/u-1/abc',
    });

    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const fileInput = fileInputs[0] as HTMLInputElement;

    const file = new File(['fake'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Expect backend was called for presigned URL.
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/users/me/avatar/upload-url',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ contentType: 'image/png' }),
        }),
      );
    });

    // Expect direct PUT to S3 (not proxied).
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9000/bucket/key?signature=xyz',
        expect.objectContaining({
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': 'image/png' },
        }),
      );
    });

    global.fetch = realFetch;
  });
});
