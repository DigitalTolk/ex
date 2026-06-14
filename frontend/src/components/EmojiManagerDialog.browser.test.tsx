import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiManagerDialog } from './EmojiManagerDialog';

// Browser coverage for EmojiManagerDialog — mount open + closed,
// upload disabled when empty, list rendering, and the delete flow.

const uploadMutate = vi.fn().mockResolvedValue(undefined);
const deleteMutate = vi.fn().mockResolvedValue(undefined);
let mockEmojis: Array<{ name: string; imageURL: string; createdBy: string; createdAt: string }> | undefined = [];
const uploadPendingRef = { value: false };

vi.mock('@/hooks/useEmoji', () => ({
  // The component awaits mutateAsync, so expose that shape.
  useEmojis: () => ({ data: mockEmojis }),
  useUploadEmoji: () => ({ mutateAsync: uploadMutate, isPending: uploadPendingRef.value }),
  useDeleteEmoji: () => ({ mutateAsync: deleteMutate, isPending: false }),
}));

const authUserRef = {
  value: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active' } as Record<string, unknown>,
};
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: authUserRef.value,
    isAuthenticated: true,
    isLoading: false,
  }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// vitest-browser-react's cleanup() doesn't await the async React unmount, so
// on WebKit the Radix dialog portal can outlive the test and stack into the
// next one (the shortcode input lives in every open dialog → ambiguous global
// queries). Track each mount and `await unmount()` it explicitly — a
// React-safe teardown, unlike ripping portal nodes out of the DOM by hand.
const mounted: Array<{ unmount: () => Promise<void> }> = [];
async function mount(ui: React.ReactElement) {
  const result = await render(ui);
  mounted.push(result);
  return result;
}

// Radix defers portal teardown until its exit animation ends; disabling
// animations makes unmount remove the portal synchronously.
let killAnims: HTMLStyleElement | null = null;

// Drive the hidden file <input> via Playwright's setInputFiles (exposed as
// userEvent.upload). Unlike assigning input.files directly, this works in
// WebKit too, and fires the change event React's onChange listens for.
async function pickFile(name = 'parrot.png', type = 'image/png') {
  // Target the freshest dialog's file input (last in DOM order) in case a
  // prior portal is still animating out.
  const inputs = document.querySelectorAll('input[type="file"]');
  const input = inputs[inputs.length - 1] as HTMLInputElement;
  await userEvent.upload(input, new File(['x'.repeat(64)], name, { type }));
}

describe('EmojiManagerDialog browser', () => {
  beforeEach(() => {
    killAnims = document.createElement('style');
    killAnims.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(killAnims);
  });
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.unmount();
    killAnims?.remove();
    killAnims = null;
    deleteMutate.mockClear();
    uploadMutate.mockClear();
    uploadPendingRef.value = false;
    authUserRef.value = { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active' };
  });

  it('does not render when closed', async () => {
    mockEmojis = [];
    await mount(
      <Wrap>
        <EmojiManagerDialog open={false} onOpenChange={vi.fn()} />
      </Wrap>,
    );
    expect(document.body.textContent).not.toMatch(/Manage emoji|Custom emoji/i);
  });

  it('renders empty state when there are no custom emojis', async () => {
    mockEmojis = [];
    await mount(
      <Wrap>
        <EmojiManagerDialog open={true} onOpenChange={vi.fn()} />
      </Wrap>,
    );
    // Some heading rendered.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('renders an existing emoji list', async () => {
    mockEmojis = [
      { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
      { name: 'meow', imageURL: 'https://emoji.test/meow.png', createdBy: 'u-2', createdAt: '2026-05-02T10:00:00Z' },
    ];
    await mount(
      <Wrap>
        <EmojiManagerDialog open={true} onOpenChange={vi.fn()} />
      </Wrap>,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('partyparrot');
      expect(document.body.textContent).toContain('meow');
    });
  });

  it('deletes a custom emoji through the confirm dialog', async () => {
    mockEmojis = [
      { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await screen.getByRole('button', { name: 'Delete :partyparrot:' }).click();
    // Confirm dialog opens; confirming routes to remove.mutateAsync(name).
    await screen.getByRole('button', { name: 'Delete emoji' }).click();
    await vi.waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('partyparrot'));
  });

  it('uploads a new emoji: pick image (preview + filename), name, Save → reset', async () => {
    mockEmojis = [];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await pickFile('parrot.png');
    // Preview tile shows the chosen image and the file name + size line.
    await vi.waitFor(() => {
      expect(document.querySelector('img[alt=""]')).not.toBeNull();
    });
    await expect.element(screen.getByText(/parrot\.png ·/)).toBeVisible();
    const nameInput = screen.getByLabelText('Emoji shortcode');
    await nameInput.fill('party_parrot');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      expect(uploadMutate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'party_parrot' }),
      );
    });
    // After a successful save the form resets (name cleared).
    await vi.waitFor(() => {
      expect((nameInput.element() as HTMLInputElement).value).toBe('');
    });
  });

  it('rejects an invalid shortcode with a validation error', async () => {
    mockEmojis = [];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await pickFile();
    // A name with an illegal char fails NAME_RE; Save is enabled (name + file
    // present) so handleSave runs and sets the validation error.
    await screen.getByLabelText('Emoji shortcode').fill('bad!name');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent(/1–32 chars/);
    expect(uploadMutate).not.toHaveBeenCalled();
  });

  it('surfaces an error when the upload mutation fails', async () => {
    mockEmojis = [];
    uploadMutate.mockRejectedValueOnce(new Error('file too large'));
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await pickFile();
    await screen.getByLabelText('Emoji shortcode').fill('valid_name');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('file too large');
  });

  it('clears the chosen image via the remove (X) button', async () => {
    mockEmojis = [];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await pickFile();
    await expect.element(screen.getByRole('button', { name: 'Remove image' })).toBeVisible();
    await screen.getByRole('button', { name: 'Remove image' }).click();
    // Preview gone → the placeholder picker is shown again, X button removed.
    await vi.waitFor(() => {
      expect(document.querySelector('button[aria-label="Remove image"]')).toBeNull();
    });
  });

  it('clears the whole draft via the Clear button', async () => {
    mockEmojis = [];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await pickFile();
    const nameInput = screen.getByLabelText('Emoji shortcode');
    await nameInput.fill('draft_name');
    await screen.getByRole('button', { name: 'Clear' }).click();
    await vi.waitFor(() => {
      expect((nameInput.element() as HTMLInputElement).value).toBe('');
      expect(document.querySelector('button[aria-label="Remove image"]')).toBeNull();
    });
  });

  it('renders the empty state and a (0) count when the emoji list is undefined', async () => {
    // emojis undefined → `emojis?.length ?? 0` and `(emojis ?? []).map` take
    // their `?? 0` / `?? []` arms.
    mockEmojis = undefined;
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await expect.element(screen.getByText(/No custom emojis yet/)).toBeVisible();
    expect(document.body.textContent).toContain('(0)');
    mockEmojis = [];
  });

  it('clears a name-only draft (no image) without revoking a preview URL', async () => {
    mockEmojis = [];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    const nameInput = screen.getByLabelText('Emoji shortcode');
    await nameInput.fill('just_a_name');
    // Clear with a name but no file → reset() runs with previewURL null, taking
    // the `if (previewURL)` false arm.
    await screen.getByRole('button', { name: 'Clear' }).click();
    await vi.waitFor(() => expect((nameInput.element() as HTMLInputElement).value).toBe(''));
  });

  it('ignores a file-input change event that carries no file', async () => {
    mockEmojis = [];
    await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    const input = document.querySelectorAll('input[type="file"]');
    const fileInput = input[input.length - 1] as HTMLInputElement;
    // Empty change → `e.target.files?.[0] ?? null` takes the `?? null` arm.
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('button[aria-label="Remove image"]')).toBeNull();
  });

  it('lets a non-admin author delete their own custom emoji', async () => {
    // Non-admin user: canDelete falls through to the `user?.id === createdBy`
    // arm — true only for their own emoji.
    authUserRef.value = { id: 'u-2', email: 'b@x.com', displayName: 'Bob', systemRole: 'member', status: 'active' };
    mockEmojis = [
      { name: 'mine', imageURL: 'https://emoji.test/mine.png', createdBy: 'u-2', createdAt: '2026-05-01T10:00:00Z' },
      { name: 'theirs', imageURL: 'https://emoji.test/theirs.png', createdBy: 'u-9', createdAt: '2026-05-01T10:00:00Z' },
    ];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    // Own emoji shows a delete button; someone else's does not.
    await expect.element(screen.getByRole('button', { name: 'Delete :mine:' })).toBeVisible();
    expect(document.querySelector('button[aria-label="Delete :theirs:"]')).toBeNull();
  });

  it('shows the pending label and disables Save while an upload is in flight', async () => {
    uploadPendingRef.value = true;
    mockEmojis = [];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await pickFile();
    await screen.getByLabelText('Emoji shortcode').fill('busy_one');
    await expect.element(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });

  it('closes the confirm dialog without deleting when cancelled', async () => {
    mockEmojis = [
      { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ];
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await screen.getByRole('button', { name: 'Delete :partyparrot:' }).click();
    // Cancel drives ConfirmDialog onOpenChange(false) → setEmojiToDelete(null).
    await screen.getByTestId('delete-emoji-cancel').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="delete-emoji"]')).toBeNull();
    });
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the upload rejects with a non-Error', async () => {
    mockEmojis = [];
    uploadMutate.mockRejectedValueOnce('weird');
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await pickFile();
    await screen.getByLabelText('Emoji shortcode').fill('valid_name');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Save failed');
  });

  it('falls back to a generic message when the delete rejects with a non-Error', async () => {
    mockEmojis = [
      { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ];
    deleteMutate.mockRejectedValueOnce('weird');
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await screen.getByRole('button', { name: 'Delete :partyparrot:' }).click();
    await screen.getByRole('button', { name: 'Delete emoji' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Delete failed');
  });

  it('surfaces an error when the delete mutation fails', async () => {
    mockEmojis = [
      { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ];
    deleteMutate.mockRejectedValueOnce(new Error('delete blocked'));
    const screen = await mount(
      <Wrap><EmojiManagerDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    await screen.getByRole('button', { name: 'Delete :partyparrot:' }).click();
    await screen.getByRole('button', { name: 'Delete emoji' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('delete blocked');
  });
});
