import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

// Force the tooltip content to render up-front so we can assert on it
// without orchestrating real hover timers in jsdom.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: React.ReactElement;
    children: React.ReactNode;
  }) => {
    const child = render as React.ReactElement<{ children?: React.ReactNode }>;
    return { ...child, props: { ...child.props, children } } as React.ReactElement;
  },
  TooltipContent: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div {...rest}>{children}</div>
  ),
}));

function renderItem(opts: {
  reactors: string[];
  emoji?: string;
  userMap?: Map<string, { displayName: string; avatarURL?: string }>;
}) {
  const msg: Message = {
    id: 'm-1',
    parentID: 'ch-1',
    authorID: 'u-other',
    body: 'hi',
    createdAt: '2026-04-26T10:00:00Z',
    reactions: { [opts.emoji ?? ':+1:']: opts.reactors },
  };
  const userMap =
    opts.userMap ??
    new Map(
      opts.reactors.map((id, i) => [id, { displayName: `User ${i + 1}` }] as const),
    );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <TooltipProvider>
          <MessageItem
            message={msg}
            authorName="Alice"
            isOwn={false}
            channelId="ch-1"
            currentUserId="u-me"
            userMap={userMap}
          />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('Reaction tooltip — list of reactors', () => {
  it('lists each reactor display name with the emoji label', () => {
    renderItem({ reactors: ['u-a', 'u-b', 'u-c'] });
    const tip = screen.getByTestId('reaction-tooltip');
    expect(tip.textContent).toContain('User 1, User 2, User 3');
    expect(tip.textContent).toContain('reacted with');
    expect(tip.textContent).toContain(':+1:');
  });

  it('renders the current user as "You"', () => {
    renderItem({ reactors: ['u-me', 'u-a'] });
    const tip = screen.getByTestId('reaction-tooltip');
    expect(tip.textContent).toContain('You, User 2');
    expect(tip.textContent).toContain('reacted with');
  });

  it('truncates to 20 names with "and N more"', () => {
    const ids = Array.from({ length: 23 }, (_, i) => `u-${i}`);
    const map = new Map(ids.map((id, i) => [id, { displayName: `User ${i + 1}` }] as const));
    renderItem({ reactors: ids, userMap: map });
    const tip = screen.getByTestId('reaction-tooltip');
    expect(tip.textContent).toContain('User 1');
    expect(tip.textContent).toContain('User 20');
    expect(tip.textContent).not.toContain('User 21');
    expect(tip.textContent).toMatch(/and 3 more/);
  });

  it('falls back to "Unknown" when a reactor is missing from the userMap', () => {
    renderItem({
      reactors: ['u-a', 'u-ghost'],
      userMap: new Map([['u-a', { displayName: 'Alice' }]]),
    });
    const tip = screen.getByTestId('reaction-tooltip');
    expect(tip.textContent).toContain('Alice, Unknown');
  });

  it('renders a large hero emoji glyph in the tooltip', () => {
    renderItem({ reactors: ['u-a'], emoji: '🎉' });
    const tip = screen.getByTestId('reaction-tooltip');
    // EmojiGlyph at size="xl" uses the text-[40px] hero size class.
    const glyph = tip.querySelector('.text-\\[40px\\]');
    expect(glyph).not.toBeNull();
    expect(glyph?.textContent).toBe('🎉');
  });
});
