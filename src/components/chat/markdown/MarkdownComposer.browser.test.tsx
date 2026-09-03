import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { createRef } from 'react';
import { userEvent } from 'vitest/browser';
import { MarkdownComposer, type WysiwygEditorHandle } from './MarkdownComposer';

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

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set(['u-1']) }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({
    data: [{ name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif' }],
  }),
  useEmojiMap: () => ({ data: { partyparrot: 'https://emoji.test/parrot.gif' } }),
}));

// The composer's "/" typeahead lists installed connectors via react-query;
// this suite renders without a QueryClientProvider, so stub the hook.
vi.mock('@/hooks/useConnectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useConnectors')>()),
  useConnectors: () => ({ data: [] }),
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

async function mountComposer(props: Partial<React.ComponentProps<typeof MarkdownComposer>> = {}) {
  const ref = createRef<WysiwygEditorHandle>();
  const screen = await render(<MarkdownComposer ref={ref} ariaLabel="Composer" {...props} />);
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return { ref, screen };
}

describe('MarkdownComposer provider wiring (browser)', () => {
  it('feeds the live roster, presence and channel membership into the @-mention typeahead', async () => {
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
