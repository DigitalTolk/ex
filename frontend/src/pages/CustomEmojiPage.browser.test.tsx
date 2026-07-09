import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CustomEmojiPage from './CustomEmojiPage';

// Browser coverage for CustomEmojiPage — the full-page replacement for the
// old emoji manager modal. Exercises upload, list/search, delete, and the
// guest guard with istanbul's accurate branch counting.

const uploadMutate = vi.fn().mockResolvedValue(undefined);
const deleteMutate = vi.fn().mockResolvedValue(undefined);
let mockEmojis: Array<{ name: string; imageURL: string; createdBy: string; createdAt: string; gettingWorkDone?: boolean }> | undefined = [];
const uploadPendingRef = { value: false };

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: mockEmojis }),
  useUploadEmoji: () => ({ mutateAsync: uploadMutate, isPending: uploadPendingRef.value }),
  useDeleteEmoji: () => ({ mutateAsync: deleteMutate, isPending: false }),
}));

const authUserRef = {
  value: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active' } as Record<string, unknown>,
};
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: authUserRef.value, isAuthenticated: true, isLoading: false }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const mounted: Array<{ unmount: () => Promise<void> }> = [];
async function mount(ui: React.ReactElement) {
  const result = await render(ui);
  mounted.push(result);
  return result;
}

let killAnims: HTMLStyleElement | null = null;

async function pickFile(name = 'parrot.png', type = 'image/png') {
  const inputs = document.querySelectorAll('input[type="file"]');
  const input = inputs[inputs.length - 1] as HTMLInputElement;
  await userEvent.upload(input, new File(['x'.repeat(64)], name, { type }));
}

const PARROT = { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' };

describe('CustomEmojiPage browser', () => {
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
    mockEmojis = [];
    authUserRef.value = { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active' };
  });

  it('blocks guests', async () => {
    authUserRef.value = { id: 'u-g', email: 'g@x.com', displayName: 'Guest', systemRole: 'guest', status: 'active' };
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await expect.element(screen.getByText(/Guests can't manage custom emojis/)).toBeVisible();
  });

  it('renders the page shell with a heading and empty state', async () => {
    mockEmojis = [];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await expect.element(screen.getByRole('heading', { name: 'Custom emojis' })).toBeVisible();
    await expect.element(screen.getByText(/No custom emojis yet/)).toBeVisible();
  });

  it('shows a (0) count and empty state when the list is undefined', async () => {
    mockEmojis = undefined;
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await expect.element(screen.getByText(/No custom emojis yet/)).toBeVisible();
    expect(document.body.textContent).toContain('(0)');
    mockEmojis = [];
  });

  it('lists existing emojis', async () => {
    mockEmojis = [
      PARROT,
      { name: 'meow', imageURL: 'https://emoji.test/meow.png', createdBy: 'u-2', createdAt: '2026-05-02T10:00:00Z' },
    ];
    await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('partyparrot');
      expect(document.body.textContent).toContain('meow');
    });
  });

  it('filters the list by the search box and shows a no-match message', async () => {
    mockEmojis = [PARROT, { name: 'meow', imageURL: 'https://emoji.test/meow.png', createdBy: 'u-2', createdAt: '2026-05-02T10:00:00Z' }];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    const search = screen.getByLabelText('Search custom emojis');
    await search.fill('parr');
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('partyparrot');
      expect(document.body.textContent).not.toContain('meow');
    });
    await search.fill('zzzzz');
    await expect.element(screen.getByText(/No emojis match your search/)).toBeVisible();
  });

  it('uploads a new emoji: pick image, name, Save → reset', async () => {
    mockEmojis = [];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile('parrot.png');
    await vi.waitFor(() => {
      expect(document.querySelector('img[alt=""]')).not.toBeNull();
    });
    await expect.element(screen.getByText(/parrot\.png ·/)).toBeVisible();
    const nameInput = screen.getByLabelText('Emoji shortcode');
    await nameInput.fill('party_parrot');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      // The shelf flag defaults OFF and rides the mutation explicitly.
      expect(uploadMutate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'party_parrot', gettingWorkDone: false }),
      );
    });
    await vi.waitFor(() => {
      expect((nameInput.element() as HTMLInputElement).value).toBe('');
    });
    // The checkbox also resets with the rest of the form.
    expect((document.querySelector('[data-testid="emoji-getting-work-done"]') as HTMLInputElement).checked).toBe(false);
  });

  it('uploads with the "Getting Work Done" shelf flag when the checkbox is ticked', async () => {
    mockEmojis = [];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile('shipit.png');
    await screen.getByLabelText('Emoji shortcode').fill('shipit');
    (document.querySelector('[data-testid="emoji-getting-work-done"]') as HTMLInputElement).click();
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => {
      expect(uploadMutate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'shipit', gettingWorkDone: true }),
      );
    });
  });

  it('marks flagged emojis in the list with the shelf label', async () => {
    mockEmojis = [
      { name: 'shipit', imageURL: 'https://cdn/s.png', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z', gettingWorkDone: true },
      { name: 'plain', imageURL: 'https://cdn/p.png', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
    ];
    await mount(<Wrap><CustomEmojiPage /></Wrap>);
    const rows = Array.from(document.querySelectorAll('.font-mono')).map((el) => el.closest('div')?.parentElement?.textContent ?? '');
    expect(rows.find((r) => r.includes(':shipit:'))).toContain('Getting Work Done');
    expect(rows.find((r) => r.includes(':plain:'))).not.toContain('Getting Work Done');
  });

  it('the picker tile forwards its click to the hidden file input', async () => {
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    const inputs = document.querySelectorAll('input[type="file"]');
    const input = inputs[inputs.length - 1] as HTMLInputElement;
    const forwarded = vi.fn();
    // The native file dialog can't open headless — intercept the input's
    // click to prove the tile forwards to it.
    input.addEventListener('click', (e) => {
      forwarded();
      e.preventDefault();
    });
    await screen.getByRole('button', { name: 'Choose image' }).click();
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid shortcode with a validation error', async () => {
    mockEmojis = [];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile();
    await screen.getByLabelText('Emoji shortcode').fill('bad!name');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent(/1–32 chars/);
    expect(uploadMutate).not.toHaveBeenCalled();
  });

  it('surfaces an error when the upload mutation fails', async () => {
    mockEmojis = [];
    uploadMutate.mockRejectedValueOnce(new Error('file too large'));
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile();
    await screen.getByLabelText('Emoji shortcode').fill('valid_name');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('file too large');
  });

  it('falls back to a generic message when the upload rejects with a non-Error', async () => {
    mockEmojis = [];
    uploadMutate.mockRejectedValueOnce('weird');
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile();
    await screen.getByLabelText('Emoji shortcode').fill('valid_name');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Save failed');
  });

  it('clears the chosen image via the remove (X) button', async () => {
    mockEmojis = [];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile();
    await expect.element(screen.getByRole('button', { name: 'Remove image' })).toBeVisible();
    await screen.getByRole('button', { name: 'Remove image' }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('button[aria-label="Remove image"]')).toBeNull();
    });
  });

  it('clears the whole draft via the Clear button', async () => {
    mockEmojis = [];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile();
    const nameInput = screen.getByLabelText('Emoji shortcode');
    await nameInput.fill('draft_name');
    await screen.getByRole('button', { name: 'Clear' }).click();
    await vi.waitFor(() => {
      expect((nameInput.element() as HTMLInputElement).value).toBe('');
      expect(document.querySelector('button[aria-label="Remove image"]')).toBeNull();
    });
  });

  it('clears a name-only draft (no image) without revoking a preview URL', async () => {
    mockEmojis = [];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    const nameInput = screen.getByLabelText('Emoji shortcode');
    await nameInput.fill('just_a_name');
    await screen.getByRole('button', { name: 'Clear' }).click();
    await vi.waitFor(() => expect((nameInput.element() as HTMLInputElement).value).toBe(''));
  });

  it('ignores a file-input change that carries no file', async () => {
    mockEmojis = [];
    await mount(<Wrap><CustomEmojiPage /></Wrap>);
    const inputs = document.querySelectorAll('input[type="file"]');
    const fileInput = inputs[inputs.length - 1] as HTMLInputElement;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('button[aria-label="Remove image"]')).toBeNull();
  });

  it('shows the pending label and disables Save while an upload is in flight', async () => {
    uploadPendingRef.value = true;
    mockEmojis = [];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile();
    await screen.getByLabelText('Emoji shortcode').fill('busy_one');
    await expect.element(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });

  it('lets a non-admin author delete only their own emoji', async () => {
    authUserRef.value = { id: 'u-2', email: 'b@x.com', displayName: 'Bob', systemRole: 'member', status: 'active' };
    mockEmojis = [
      { name: 'mine', imageURL: 'https://emoji.test/mine.png', createdBy: 'u-2', createdAt: '2026-05-01T10:00:00Z' },
      { name: 'theirs', imageURL: 'https://emoji.test/theirs.png', createdBy: 'u-9', createdAt: '2026-05-01T10:00:00Z' },
    ];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await expect.element(screen.getByRole('button', { name: 'Delete :mine:' })).toBeVisible();
    expect(document.querySelector('button[aria-label="Delete :theirs:"]')).toBeNull();
  });

  it('deletes a custom emoji through the confirm dialog', async () => {
    mockEmojis = [PARROT];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await screen.getByRole('button', { name: 'Delete :partyparrot:' }).click();
    await screen.getByRole('button', { name: 'Delete emoji' }).click();
    await vi.waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('partyparrot'));
  });

  it('closes the confirm dialog without deleting when cancelled', async () => {
    mockEmojis = [PARROT];
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await screen.getByRole('button', { name: 'Delete :partyparrot:' }).click();
    await screen.getByTestId('delete-emoji-cancel').click();
    // The dialog unmounts on its exit-animation `animationend` (Base UI,
    // duration-100). Under heavy full-suite parallel load that occasionally
    // outlasts vi.waitFor's default 1000ms, so give the removal generous slack.
    await vi.waitFor(
      () => {
        expect(document.querySelector('[data-testid="delete-emoji"]')).toBeNull();
      },
      { timeout: 5000 },
    );
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('surfaces an error when the delete mutation fails', async () => {
    mockEmojis = [PARROT];
    deleteMutate.mockRejectedValueOnce(new Error('delete blocked'));
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await screen.getByRole('button', { name: 'Delete :partyparrot:' }).click();
    await screen.getByRole('button', { name: 'Delete emoji' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('delete blocked');
  });

  it('falls back to a generic message when the delete rejects with a non-Error', async () => {
    mockEmojis = [PARROT];
    deleteMutate.mockRejectedValueOnce('weird');
    const screen = await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await screen.getByRole('button', { name: 'Delete :partyparrot:' }).click();
    await screen.getByRole('button', { name: 'Delete emoji' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Delete failed');
  });

  it('replaces a previously chosen image, revoking the old preview', async () => {
    mockEmojis = [];
    await mount(<Wrap><CustomEmojiPage /></Wrap>);
    await pickFile('first.png');
    await vi.waitFor(() => expect(document.querySelector('img[alt=""]')).not.toBeNull());
    // Picking again drives handleFileChange's `if (previewURL)` revoke arm.
    await pickFile('second.png');
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('second.png');
    });
  });
});
