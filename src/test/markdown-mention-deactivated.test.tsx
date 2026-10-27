import { describe, it, expect, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { MarkdownComposer } from '@/components/chat/markdown/MarkdownComposer';

// Nobody can mention a deactivated account: the @-list leaves it out.

vi.mock('@/hooks/useConversations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConversations')>()),
  useAllUsers: () => ({
    data: [
      { id: 'u-ali', displayName: 'Ali Active', email: 'ali@x.se', status: 'active' },
      { id: 'u-gone', displayName: 'Ali Gone', email: 'gone@x.se', status: 'deactivated' },
    ],
  }),
}));
vi.mock('@/hooks/useChannels', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useChannels')>()),
  useChannelMembers: () => ({ data: [] }),
  useUserChannels: () => ({ data: [] }),
}));
vi.mock('@/hooks/useEmoji', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useEmoji')>()),
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));
vi.mock('@/hooks/useConnectors', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConnectors')>()),
  useConnectors: () => ({ data: [] }),
}));
vi.mock('@/hooks/useAgents', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useAgents')>()),
  useSkills: () => ({ data: [] }),
}));
vi.mock('@/hooks/useProjects', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useProjects')>()),
  useProjects: () => ({ data: undefined }),
}));

describe('MarkdownComposer @-mentions', () => {
  it('offers active accounts and never a deactivated one', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MarkdownComposer ariaLabel="Composer" />
      </QueryClientProvider>,
    );
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    act(() => {
      view.dispatch({ changes: { from: 0, insert: '@Ali' }, selection: { anchor: 4 } });
      startCompletion(view);
    });
    await waitFor(() => expect(currentCompletions(view.state).map((c) => c.label)).toContain('Ali Active'));
    expect(currentCompletions(view.state).map((c) => c.label)).not.toContain('Ali Gone');
  });
});
