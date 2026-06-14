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
});
