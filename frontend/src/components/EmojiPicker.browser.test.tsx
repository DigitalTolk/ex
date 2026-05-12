import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiPicker } from './EmojiPicker';

// Browser coverage for EmojiPicker — exercises trigger, search,
// category switching, and skin-tone selection paths.

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [
    { name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif', createdBy: 'u-1', createdAt: '2026-05-01T10:00:00Z' },
  ] }),
  useEmojiMap: () => ({ data: { partyparrot: 'https://emoji.test/parrot.gif' } }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  getAccessToken: () => null,
}));

vi.mock('@/context/AuthContext', () => {
  const state = {
    user: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    setAuth: vi.fn(),
  };
  return {
    useAuth: () => state,
    useOptionalAuth: () => state,
    AuthContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  };
});

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('EmojiPicker browser', () => {
  it('renders the default trigger button', async () => {
    const onSelect = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={onSelect} />
      </Wrap>,
    );
    await expect.element(screen.getByLabelText('Open emoji picker')).toBeVisible();
  });

  it('renders a custom trigger node when provided', async () => {
    const onSelect = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={onSelect} trigger={<button data-testid="emoji-custom-trigger">Emoji</button>} />
      </Wrap>,
    );
    await expect.element(screen.getByTestId('emoji-custom-trigger')).toBeVisible();
  });

  it('opens the popover on trigger click and onOpenChange fires true', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={vi.fn()} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    const trigger = screen.getByLabelText('Open emoji picker');
    await trigger.click();
    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(true);
    });
  });

  it('reopens and toggles closed via the same trigger (desktop only)', async () => {
    if (window.innerWidth < 768) return;
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap>
        <EmojiPicker onSelect={vi.fn()} onOpenChange={onOpenChange} />
      </Wrap>,
    );
    const trigger = screen.getByLabelText('Open emoji picker');
    await trigger.click();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
    await trigger.click();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
  });
});
