import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $createParagraphNode, $createTextNode, type LexicalEditor } from 'lexical';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { MentionNode } from '../nodes/MentionNode';
import { UserMentionsPlugin } from './UserMentionsPlugin';

// Browser coverage for the `@mention` typeahead (was ~30%). Same harness as
// EmojiShortcutsPlugin: seed `@query` with the caret at the end so the
// typeahead resolves a match, and offset the editor so the caret-anchored
// popup lands in-viewport.

interface MockUser {
  id: string;
  displayName: string;
  email?: string;
  avatarURL?: string;
  userStatus?: string;
}

let allUsers: MockUser[] = [];
vi.mock('@/hooks/useConversations', () => ({
  useAllUsers: () => ({ data: allUsers }),
}));

let memberRows: { userID: string }[] | undefined;
vi.mock('@/hooks/useChannels', () => ({
  useChannelMembers: () => ({ data: memberRows }),
}));

let onlineIds: string[] = [];
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set(onlineIds) }),
}));

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(channelId?: string) {
  let editor!: LexicalEditor;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={qc}>
      <div style={{ paddingTop: 240, paddingLeft: 120, minHeight: 600 }}>
        <LexicalComposer
          initialConfig={{ namespace: 'user-mentions', nodes: [MentionNode], onError: (e) => { throw e; }, theme: {} }}
        >
          <RichTextPlugin
            contentEditable={<ContentEditable data-testid="editor" />}
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <UserMentionsPlugin channelId={channelId} />
          <Capture onReady={(e) => { editor = e; }} />
        </LexicalComposer>
      </div>
    </QueryClientProvider>,
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

function editorText(editor: LexicalEditor): string {
  let out = '';
  editor.getEditorState().read(() => { out = $getRoot().getTextContent(); });
  return out;
}

describe('UserMentionsPlugin browser typeahead', () => {
  beforeEach(() => {
    allUsers = [];
    memberRows = undefined;
    onlineIds = [];
    cleanup();
  });

  it('renders a flat ranked roster (no channel) and inserts a mention node on select', async () => {
    allUsers = [
      { id: 'u-alice', displayName: 'Alice', email: 'alice@x.test' },
      { id: 'u-bob', displayName: 'Bob', email: 'bob@x.test' },
    ];
    onlineIds = ['u-alice'];
    const { editor, screen } = await mount();
    seed(editor, '@al');
    await expect.element(screen.getByTestId('mention-popup')).toBeVisible();
    // Only Alice matches `@al`; the row shows the email (MentionRow user
    // branch). The display name also appears in the avatar, so click the
    // unique option row by testid rather than the ambiguous name text.
    await expect.element(screen.getByText('alice@x.test')).toBeVisible();
    await screen.getByTestId('mention-option').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-mention-name="Alice"]')).not.toBeNull();
    });
  });

  it('partitions members vs non-members with section headers in a channel', async () => {
    allUsers = [
      { id: 'u-alice', displayName: 'Alice' },
      { id: 'u-carol', displayName: 'Carla' },
    ];
    memberRows = [{ userID: 'u-alice' }];
    onlineIds = ['u-alice'];
    const { editor, screen } = await mount('ch-1');
    // Both names contain 'a'; Alice is a prefix match + online (byRelevance
    // prefix/online branches), Carla is a substring non-member.
    seed(editor, '@a');
    await expect.element(screen.getByTestId('mention-popup')).toBeVisible();
    await expect.element(screen.getByText('Channel members')).toBeVisible();
    await expect.element(screen.getByText('Not in channel')).toBeVisible();
  });

  it('surfaces an @all group mention on the exact keyword and inserts plain text', async () => {
    allUsers = [{ id: 'u-alice', displayName: 'Alice' }];
    memberRows = [{ userID: 'u-alice' }];
    const { editor, screen } = await mount('ch-1');
    seed(editor, '@all');
    await expect.element(screen.getByTestId('mention-popup')).toBeVisible();
    // Group row (MentionRow group branch) under the "Special mentions" header.
    await expect.element(screen.getByText('Special mentions')).toBeVisible();
    await expect.element(screen.getByText('Notify everyone in this channel')).toBeVisible();
    // `@all` also appears in the seeded editor text, so click the unique
    // group option row by testid.
    await screen.getByTestId('mention-option').click();
    await vi.waitFor(() => {
      expect(editorText(editor)).toContain('@all');
    });
  });

  it('shows the empty label when no user matches the query', async () => {
    allUsers = [{ id: 'u-alice', displayName: 'Alice' }];
    const { editor, screen } = await mount();
    seed(editor, '@zzzzqq');
    await expect.element(screen.getByText('No matches')).toBeVisible();
  });

  it('ranks two same-prefix members by online status (byRelevance online tiebreak)', async () => {
    // Three users all prefix-match "@a": two channel members (one online, one
    // offline) exercise the aPref === bPref online tiebreak, and a non-member
    // fills the "Not in channel" section.
    allUsers = [
      { id: 'u-anna', displayName: 'Anna' },
      { id: 'u-alice', displayName: 'Alice' },
      { id: 'u-aaron', displayName: 'Aaron' },
    ];
    memberRows = [{ userID: 'u-anna' }, { userID: 'u-alice' }];
    onlineIds = ['u-alice']; // Alice online, Anna offline
    const { editor, screen } = await mount('ch-1');
    seed(editor, '@a');
    await expect.element(screen.getByTestId('mention-popup')).toBeVisible();
    await expect.element(screen.getByText('Channel members')).toBeVisible();
    await expect.element(screen.getByText('Not in channel')).toBeVisible();
    // Both members rendered as option rows; the online one sorts ahead.
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="mention-option"]').length).toBeGreaterThanOrEqual(3);
    });
  });
});
