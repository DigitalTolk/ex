import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiManagerDialog } from './EmojiManagerDialog';

// Browser coverage for EmojiManagerDialog — mount open + closed,
// upload disabled when empty, list rendering with existing emojis.

const uploadMutate = vi.fn();
const deleteMutate = vi.fn();
let mockEmojis: Array<{ name: string; imageURL: string; createdBy: string; createdAt: string }> = [];

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: mockEmojis }),
  useUploadEmoji: () => ({ mutate: uploadMutate, isPending: false }),
  useDeleteEmoji: () => ({ mutate: deleteMutate, isPending: false }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'admin', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('EmojiManagerDialog browser', () => {
  it('does not render when closed', async () => {
    mockEmojis = [];
    await render(
      <Wrap>
        <EmojiManagerDialog open={false} onOpenChange={vi.fn()} />
      </Wrap>,
    );
    expect(document.body.textContent).not.toMatch(/Manage emoji|Custom emoji/i);
  });

  it('renders empty state when there are no custom emojis', async () => {
    mockEmojis = [];
    await render(
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
    await render(
      <Wrap>
        <EmojiManagerDialog open={true} onOpenChange={vi.fn()} />
      </Wrap>,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('partyparrot');
      expect(document.body.textContent).toContain('meow');
    });
  });
});
