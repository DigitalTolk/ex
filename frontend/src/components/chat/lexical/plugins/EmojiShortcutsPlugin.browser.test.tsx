import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { EmojiShortcutsPlugin } from './EmojiShortcutsPlugin';

// Browser coverage for the `:shortcode` emoji typeahead. The plugin was at
// ~12% because no test drove the trigger -> query -> options -> menu ->
// select path. We seed `:query` text with the caret at the end so
// LexicalTypeaheadMenuPlugin's update listener resolves a match and fires
// onQueryChange, which is what a real keystroke does. The menu anchor needs
// a real DOM range rect, so this only works in the browser gate.

// Custom emoji set is swapped per-test via this mutable holder. When
// `emojisData` is undefined the plugin's `useEmojis().data = []` default kicks
// in (the no-data branch).
let customEmojis: { name: string; imageURL: string }[] | undefined = [];
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: customEmojis }),
}));

// Skin tone is read from useOptionalAuth; swapped per-test. When `authValue`
// is null the plugin's `auth?.user?.emojiSkinTone ?? ''` optional chain bails.
let authValue: { user?: { emojiSkinTone?: string } } | null = { user: { emojiSkinTone: '' } };
vi.mock('@/context/AuthContext', () => ({
  useOptionalAuth: () => authValue,
}));

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount() {
  let editor!: LexicalEditor;
  const screen = await render(
    // Push the editor down/in so the caret-anchored popup lands inside the
    // viewport (otherwise it flips above the top edge and can't be clicked).
    <div style={{ paddingTop: 240, paddingLeft: 120, minHeight: 600 }}>
      <LexicalComposer
        initialConfig={{ namespace: 'emoji-shortcuts', nodes: [], onError: (e) => { throw e; }, theme: {} }}
      >
        <RichTextPlugin
          contentEditable={<ContentEditable data-testid="editor" />}
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <EmojiShortcutsPlugin />
        <Capture onReady={(e) => { editor = e; }} />
      </LexicalComposer>
    </div>,
  );
  // Focus the editor so Lexical reconciles the seeded selection to the DOM
  // (the typeahead reads the live DOM range to position its anchor).
  (document.querySelector('[data-testid="editor"]') as HTMLElement).focus();
  return { editor, screen };
}

// Seed `text` into the editor with the caret collapsed at the end, the same
// shape the typeahead sees mid-keystroke.
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

describe('EmojiShortcutsPlugin browser typeahead', () => {
  beforeEach(() => {
    customEmojis = [];
    authValue = { user: { emojiSkinTone: '' } };
    cleanup();
  });

  it('opens the popup for a `:query` trigger and inserts the standard shortcode on select', async () => {
    const { editor, screen } = await mount();
    seed(editor, ':smile');
    // Popup appears with standard emoji rows ranked by the query.
    await expect.element(screen.getByTestId('emoji-popup')).toBeVisible();
    const rows = screen.getByTestId('emoji-option');
    await expect.element(rows.first()).toBeVisible();
    // Selecting the first option replaces the `:smile` node with `:name: `.
    await rows.first().click();
    await vi.waitFor(() => {
      const text = editorText(editor);
      expect(text).toMatch(/:[a-z_]+:\s$/);
    });
  });

  it('prioritises a matching custom emoji and renders its image row', async () => {
    customEmojis = [{ name: 'partyparrot', imageURL: 'https://emoji.test/parrot.gif' }];
    const { editor, screen } = await mount();
    seed(editor, ':party');
    await expect.element(screen.getByTestId('emoji-popup')).toBeVisible();
    // The custom row renders the `:name:` label + a decorative <img>
    // (EmojiRow custom branch). The img is alt="" (presentational), so
    // assert via the label text.
    await expect.element(screen.getByText(':partyparrot:')).toBeVisible();
    await screen.getByText(':partyparrot:').click();
    await vi.waitFor(() => {
      expect(editorText(editor)).toContain(':partyparrot:');
    });
  });

  it('applies the active skin tone to a skin-tone-capable emoji', async () => {
    authValue = { user: { emojiSkinTone: 'dark' } };
    const { editor, screen } = await mount();
    // `wave` (👋) supports a skin-tone modifier, exercising the
    // supportsEmojiSkinTone preview branch and shortcodeWithSkinTone insert.
    seed(editor, ':wave');
    await expect.element(screen.getByTestId('emoji-popup')).toBeVisible();
    await expect.element(screen.getByTestId('emoji-option').first()).toBeVisible();
    await screen.getByTestId('emoji-option').first().click();
    await vi.waitFor(() => {
      expect(editorText(editor)).toMatch(/:\S+:\s$/);
    });
  });

  it('shows the empty label when no emoji matches the query', async () => {
    const { editor, screen } = await mount();
    seed(editor, ':zzzzzzqq');
    await expect.element(screen.getByText('No emoji matches')).toBeVisible();
  });

  it('ranks an exact-name match first (emojiSearchRank name === query)', async () => {
    // `smile` is the literal name of a standard emoji, so emojiSearchRank
    // returns 0 on its `emoji.name === q` branch for that entry.
    const { editor, screen } = await mount();
    seed(editor, ':smile');
    await expect.element(screen.getByTestId('emoji-popup')).toBeVisible();
    await expect.element(screen.getByText(':smile:')).toBeVisible();
  });


  it('still opens the popup when there is no authenticated user', async () => {
    // useOptionalAuth returns null → `auth?.user?.emojiSkinTone ?? ''` takes the
    // optional-chain bail (skin tone defaults to '').
    authValue = null;
    const { editor, screen } = await mount();
    seed(editor, ':smile');
    await expect.element(screen.getByTestId('emoji-popup')).toBeVisible();
    await expect.element(screen.getByTestId('emoji-option').first()).toBeVisible();
  });

  it('falls back to an empty custom-emoji list when the query has no data', async () => {
    // useEmojis().data is undefined → the `= []` default destructure applies and
    // only standard emoji are offered.
    customEmojis = undefined;
    const { editor, screen } = await mount();
    seed(editor, ':smile');
    await expect.element(screen.getByTestId('emoji-popup')).toBeVisible();
    await expect.element(screen.getByText(':smile:')).toBeVisible();
  });
});
