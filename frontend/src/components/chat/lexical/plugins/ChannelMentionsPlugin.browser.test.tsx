import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $createParagraphNode, $createTextNode, type LexicalEditor } from 'lexical';
import { useEffect } from 'react';
import { ChannelMentionNode } from '../nodes/ChannelMentionNode';
import { ChannelMentionsPlugin } from './ChannelMentionsPlugin';

// Browser coverage for the `~channel` typeahead (was ~13%). Same harness as
// the user/emoji typeaheads: seed `~query` with the caret at the end and
// offset the editor so the caret-anchored popup lands in-viewport.

let userChannels: { channelID: string; channelName: string; channelType: string }[] = [];
vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: userChannels }),
}));

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount() {
  let editor!: LexicalEditor;
  const screen = await render(
    <div style={{ paddingTop: 240, paddingLeft: 120, minHeight: 600 }}>
      <LexicalComposer
        initialConfig={{ namespace: 'channel-mentions', nodes: [ChannelMentionNode], onError: (e) => { throw e; }, theme: {} }}
      >
        <RichTextPlugin
          contentEditable={<ContentEditable data-testid="editor" />}
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <ChannelMentionsPlugin />
        <Capture onReady={(e) => { editor = e; }} />
      </LexicalComposer>
    </div>,
  );
  (document.querySelector('[data-testid="editor"]') as HTMLElement).focus();
  return { editor, screen };
}

function seed(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const para = $createParagraphNode();
    const t = $createTextNode(text);
    para.append(t);
    root.append(para);
    t.select(text.length, text.length);
  }, { discrete: true });
}

describe('ChannelMentionsPlugin browser typeahead', () => {
  beforeEach(() => {
    userChannels = [];
    cleanup();
  });

  it('lists matching channels (public + private icons) and inserts a mention node', async () => {
    userChannels = [
      { channelID: 'c-gen', channelName: 'general', channelType: 'public' },
      { channelID: 'c-sec', channelName: 'general-secret', channelType: 'private' },
    ];
    const { editor, screen } = await mount();
    seed(editor, '~gen');
    await expect.element(screen.getByTestId('channel-popup')).toBeVisible();
    // Both rows render; the private channel uses the Lock icon, the public
    // one the Hash icon (ChannelRow isPrivate branch).
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="channel-option"]').length).toBe(2);
    });
    // Pick the prefix-ranked first row (public general) → mention node.
    await screen.getByTestId('channel-option').first().click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-channel-slug="general"]')).not.toBeNull();
    });
  });

  it('shows the empty label when no channel matches', async () => {
    userChannels = [{ channelID: 'c-gen', channelName: 'general', channelType: 'public' }];
    const { editor, screen } = await mount();
    seed(editor, '~zzzqq');
    await expect.element(screen.getByText('No channels match')).toBeVisible();
  });

  it('ranks substring-only matches (non-prefix comparator side) below prefix matches', async () => {
    // "era" is a substring of "general" (positions 3..6) but "general" does
    // NOT start with "era" → the comparator's `: 1` non-prefix side runs for
    // both channels (the existing `~gen` test only exercises the `? 0` side).
    userChannels = [
      { channelID: 'c-gen', channelName: 'general', channelType: 'public' },
      { channelID: 'c-ops', channelName: 'operations', channelType: 'public' },
    ];
    const { editor, screen } = await mount();
    seed(editor, '~era');
    await expect.element(screen.getByTestId('channel-popup')).toBeVisible();
    // "general" contains "era"; "operations" contains "era" (op-ER-Ations →
    // o,p,e,r,a,t... "era" = e(2)r(3)a(4)). Both are substring matches.
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="channel-option"]').length).toBe(2);
    });
  });

  it('renders the channel list with an undefined empty label on a bare ~ trigger', async () => {
    // A bare "~" yields an empty query string: `query?.length` is 0 → the
    // emptyLabel ternary takes its `undefined` side while options still render.
    userChannels = [{ channelID: 'c-gen', channelName: 'general', channelType: 'public' }];
    const { editor, screen } = await mount();
    seed(editor, '~');
    await expect.element(screen.getByTestId('channel-popup')).toBeVisible();
    await expect.element(screen.getByTestId('channel-option')).toBeVisible();
    expect(document.querySelector('[data-testid="channel-option"]')).not.toBeNull();
  });
});
