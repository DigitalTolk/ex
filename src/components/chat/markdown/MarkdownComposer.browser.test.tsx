import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Profiler, createRef } from 'react';
import { userEvent } from 'vitest/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MarkdownComposer, type WysiwygEditorHandle } from './MarkdownComposer';
import { usePresenceStore } from '@/stores/presence';
import { apiFetch } from '@/lib/api';

// Browser coverage for the production composer wiring: MarkdownComposer's
// completion-provider thunks (users/online/memberIds/channels/customEmojis/
// skinTone) and the customEmojiMap thunk only run when the CodeMirror
// autocomplete actually fires, which no other browser test drives through
// this component (view tests stub MarkdownComposer). The app hooks are mocked
// with deterministic rosters; the editor, autocomplete and typeahead are real.

vi.mock('@/hooks/useConversations', () => ({
  useAllUsers: () => ({
    data: [
      {
        id: 'u-1',
        displayName: 'Alice Wonder',
        email: 'alice@x.test',
        avatarURL: 'https://x.test/alice.png',
        userStatus: { emoji: '🎯', text: 'Focusing' },
      },
      { id: 'u-2', displayName: 'Alan Border', email: 'alan@x.test', avatarURL: '' },
    ],
  }),
}));

vi.mock('@/hooks/useChannels', () => ({
  useChannelMembers: (channelID?: string) => ({
    data: channelID ? [{ userID: 'u-1' }] : undefined,
  }),
  useUserChannels: () => ({
    data: [
      { channelID: 'c-1', channelName: 'general', channelType: 'public' },
      { channelID: 'c-2', channelName: 'go-private', channelType: 'private' },
    ],
  }),
}));


vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({
    data: [{ name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif' }],
  }),
  useEmojiMap: () => ({ data: { partyparrot: 'https://emoji.test/parrot.gif' } }),
}));

// The composer's "/" typeahead lists installed connectors and projects via
// react-query; this suite renders without a QueryClientProvider, so stub the
// hooks.
vi.mock('@/hooks/useConnectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useConnectors')>()),
  useConnectors: () => ({ data: [] }),
}));
vi.mock('@/hooks/useProjects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useProjects')>()),
  useProjects: () => ({ data: [] }),
}));
vi.mock('@/hooks/useAgents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAgents')>()),
  useSkills: () => ({ data: [] }),
}));

// What the composer asks the server itself: the writer's people ranking, and
// a DM's participants (the DM view has those cached; here the composer loads
// them).
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (url: string) => {
    if (url.startsWith('/api/v1/users/me/frequent-people')) return ['u-2'];
    if (url === '/api/v1/conversations/d-1') return { id: 'd-1', participantIDs: ['u-me', 'u-2'] };
    return undefined;
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useOptionalAuth: () => ({
    user: { id: 'u-me', email: 'me@x.test', displayName: 'Me', emojiSkinTone: 'medium' },
  }),
}));

function tooltip(): HTMLElement | null {
  // composerTooltips portals the typeahead to document.body.
  return document.body.querySelector('.cm-tooltip-autocomplete');
}

function withQueries(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

async function mountComposer(props: Partial<React.ComponentProps<typeof MarkdownComposer>> = {}) {
  const ref = createRef<WysiwygEditorHandle>();
  const screen = await render(withQueries(<MarkdownComposer ref={ref} ariaLabel="Composer" {...props} />));
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return { ref, screen };
}

describe('MarkdownComposer provider wiring (browser)', () => {
  it('feeds the live roster, presence and channel membership into the @-mention typeahead', async () => {
    usePresenceStore.setState({ online: new Set(['u-1']) });
    const { screen } = await mountComposer({ mentionChannelId: 'c-1' });
    await userEvent.click(screen.getByLabelText('Composer'));
    await userEvent.keyboard('@a');
    await vi.waitFor(() => expect(tooltip()).not.toBeNull());
    const tip = tooltip()!;
    // users() + the per-user mapping (incl. activeStatus emoji) produced rows.
    expect(tip.textContent).toContain('Alice Wonder');
    expect(tip.textContent).toContain('Alan Border');
    // memberIds() partitioned the list: u-1 is a member, u-2 is not.
    expect(tip.textContent).toContain('Channel members');
    expect(tip.textContent).toContain('Not in channel');
    await screen.unmount();
  });

  it('in a DM, lists its participants first, each part ordered by who the writer talks to most', async () => {
    usePresenceStore.setState({ online: new Set(['u-1']) });
    const { screen } = await mountComposer({ mentionConversationId: 'd-1' });
    await userEvent.click(screen.getByLabelText('Composer'));
    await userEvent.keyboard('@a');
    await vi.waitFor(() => expect(tooltip()?.textContent).toContain('In this conversation'));
    const rows = Array.from(tooltip()!.querySelectorAll('li')).map((li) => li.textContent ?? '');
    // Alan (u-2) is in the DM; Alice is online but isn't.
    expect(rows.findIndex((r) => r.includes('Alan Border'))).toBeLessThan(rows.findIndex((r) => r.includes('Alice Wonder')));
    expect(tooltip()!.textContent).toContain('Not in this conversation');
    await screen.unmount();
  });

  it('in a thread reply, lists the thread\'s writers first', async () => {
    const { screen } = await mountComposer({ mentionChannelId: 'c-1', mentionThreadIds: ['u-2'] });
    await userEvent.click(screen.getByLabelText('Composer'));
    await userEvent.keyboard('@a');
    await vi.waitFor(() => expect(tooltip()?.textContent).toContain('In this thread'));
    const text = tooltip()!.textContent ?? '';
    expect(text.indexOf('Alan Border')).toBeLessThan(text.indexOf('Alice Wonder'));
    expect(text).toContain('Channel members');
    await screen.unmount();
  });

  it('ranks the people the writer mentions and messages most first in a flat list', async () => {
    usePresenceStore.setState({ online: new Set(['u-1']) });
    const { screen } = await mountComposer();
    await userEvent.click(screen.getByLabelText('Composer'));
    // Wait for the ranking to land, then open the list.
    await vi.waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(expect.stringContaining('/frequent-people')));
    await userEvent.keyboard('@a');
    await vi.waitFor(() => expect(tooltip()?.textContent).toContain('Alan Border'));
    const text = tooltip()!.textContent ?? '';
    expect(text.indexOf('Alan Border')).toBeLessThan(text.indexOf('Alice Wonder'));
    await screen.unmount();
  });

  it('reads presence when the @-list opens instead of re-rendering for every presence change', async () => {
    const commits = { count: 0 };
    const screen = await render(
      withQueries(
        <Profiler id="composer" onRender={() => { commits.count++; }}>
          <MarkdownComposer ariaLabel="Composer" />
        </Profiler>,
      ),
    );
    // The people ranking lands once; after that nothing re-renders it.
    await vi.waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(expect.stringContaining('/frequent-people')));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))));
    const settled = commits.count;
    usePresenceStore.getState().setUserOnline('u-2', true);
    usePresenceStore.getState().setUserOnline('u-elsewhere', true);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(commits.count).toBe(settled);

    // …and the list it opens still shows who is online right now.
    await userEvent.click(screen.getByLabelText('Composer'));
    await userEvent.keyboard('@ala');
    await vi.waitFor(() => expect(tooltip()?.textContent).toContain('Alan Border'));
    expect(tooltip()!.querySelector('[data-presence="online"]')).not.toBeNull();
    await screen.unmount();
  });

  it('feeds the joined-channel list into the ~-channel typeahead', async () => {
    const { screen } = await mountComposer();
    await userEvent.click(screen.getByLabelText('Composer'));
    await userEvent.keyboard('~g');
    await vi.waitFor(() => expect(tooltip()).not.toBeNull());
    const tip = tooltip()!;
    // channels() + its row mapping (public and private) produced options.
    expect(tip.textContent).toContain('~general');
    expect(tip.textContent).toContain('~go-private');
    await screen.unmount();
  });

  it('feeds custom emojis, the skin tone and the emoji map into the :emoji: typeahead and glyphs', async () => {
    // initialBody containing a custom shortcode drives the customEmojiMap
    // thunk through the emoji-glyph decorator on mount.
    const { ref, screen } = await mountComposer({ initialBody: 'party :partyparrot: soon ' });
    await userEvent.click(screen.getByLabelText('Composer'));
    ref.current!.focusEnd();
    await userEvent.keyboard(':par');
    await vi.waitFor(() => expect(tooltip()).not.toBeNull());
    // customEmojis() + skinTone() fed the emoji source.
    expect(tooltip()!.textContent).toContain(':partyparrot:');
    await screen.unmount();
  });
});
