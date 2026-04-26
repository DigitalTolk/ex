import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  authProvider: 'guest' as const,
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
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('EditProfileDialog - theme buttons + save errors', () => {
  it('switching theme to dark adds dark class', async () => {
    const user = userEvent.setup();
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Dark theme' }));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  it('switching theme to light removes dark class', async () => {
    document.documentElement.classList.add('dark');
    const user = userEvent.setup();
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Light theme' }));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  it('switching theme to system invokes setTheme(system)', async () => {
    const user = userEvent.setup();
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'System theme' }));
    expect(localStorage.getItem('theme')).toBe('system');
  });

  it('shows error message and stays open when save API fails', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('save failed'));
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={onOpenChange} />);

    const nameInput = screen.getByLabelText('Display name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Different Name');
    await user.click(screen.getByText('Save'));

    expect(await screen.findByRole('alert')).toHaveTextContent('save failed');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('shows error when avatar upload presign fails', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('presign denied'));
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const fileInput = fileInputs[0] as HTMLInputElement;
    const file = new File(['fake'], 'a.png', { type: 'image/png' });

    // Use fireEvent-like approach: set files and dispatch change
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(await screen.findByRole('alert')).toHaveTextContent('presign denied');
  });

  it('shows error when S3 PUT response is not ok', async () => {
    const realFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    mockApiFetch.mockResolvedValueOnce({
      uploadURL: 'http://s3/upload',
      key: 'avatars/u-1/k',
    });

    renderWithTheme(<EditProfileDialog open={true} onOpenChange={vi.fn()} />);

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const fileInput = fileInputs[0] as HTMLInputElement;
    const file = new File(['fake'], 'a.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/upload failed: 500/i);

    global.fetch = realFetch;
  });

  it('saves with avatarKey when an avatar was uploaded successfully', async () => {
    const realFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    // 1st: presign
    mockApiFetch.mockResolvedValueOnce({
      uploadURL: 'http://s3/upload',
      key: 'avatars/u-1/k',
    });
    // 2nd: save profile
    mockApiFetch.mockResolvedValueOnce({ ...mockUser, avatarURL: 'http://s3/avatar' });

    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderWithTheme(<EditProfileDialog open={true} onOpenChange={onOpenChange} />);

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const fileInput = fileInputs[0] as HTMLInputElement;
    const file = new File(['fake'], 'a.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait for upload completed
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/users/me',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ avatarKey: 'avatars/u-1/k' }),
        }),
      );
    });
    expect(mockSetAuth).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    global.fetch = realFetch;
  });
});
