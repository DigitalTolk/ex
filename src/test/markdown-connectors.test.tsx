import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cursorCharLeft } from '@codemirror/commands';
import { slashCommandSource } from '@/components/chat/markdown/extensions/slashCommands';
import { connectorPills } from '@/components/chat/markdown/extensions/mentionPills';
import { MarkdownComposer } from '@/components/chat/markdown/MarkdownComposer';
import type { MentionCompletion } from '@/components/chat/markdown/extensions/optionRender';

vi.mock('@/hooks/useConversations', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConversations')>()),
  useAllUsers: () => ({ data: [] }),
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
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>() }),
}));
vi.mock('@/context/AuthContext', async (orig) => ({
  ...(await orig<typeof import('@/context/AuthContext')>()),
  useOptionalAuth: () => null,
}));
vi.mock('@/hooks/useConnectors', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useConnectors')>()),
  useConnectors: () => ({
    data: [
      { slug: 'gitlab', title: 'GitLab', description: 'MRs and issues', baseURL: '', authKind: 'none', installed: true },
      { slug: 'trello', title: 'Trello', description: 'Boards', baseURL: '', authKind: 'none', installed: false },
    ],
  }),
}));

function ctx(doc: string, pos = doc.length): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), pos, false);
}

const providers = {
  commands: () => [
    { name: 'deploy', description: 'Ship it' },
    { name: 'standup', description: 'Post the standup' },
  ],
  connectors: () => [
    { name: 'gitlab', description: 'GitLab — MRs' },
    { name: 'trello', description: 'Trello — boards' },
  ],
};

describe('slashCommandSource', () => {
  it('returns null without a slash token or with empty providers', () => {
    expect(slashCommandSource(providers)(ctx('hello'))).toBeNull();
    expect(slashCommandSource({})(ctx('/dep'))).toBeNull();
  });

  it('never pops mid-word: a slash glued to text bails', () => {
    expect(slashCommandSource(providers)(ctx('a/b', 3))).toBeNull();
    // …but a slash after whitespace is a word start.
    const res = slashCommandSource(providers)(ctx('ask /git', 8));
    expect(res?.options.map((o) => o.label)).toEqual(['/gitlab']);
  });

  it('offers commands only as the whole message, connectors anywhere', () => {
    const atStart = slashCommandSource(providers)(ctx('/'));
    expect(atStart?.options.map((o) => o.label)).toEqual(['/deploy', '/standup', '/gitlab', '/trello']);

    const midMessage = slashCommandSource(providers)(ctx('check /'));
    expect(midMessage?.options.map((o) => o.label)).toEqual(['/gitlab', '/trello']);

    const filtered = slashCommandSource(providers)(ctx('/dep'));
    expect(filtered?.options.map((o) => o.label)).toEqual(['/deploy']);
  });

  it('applies a command as the whole message and a connector pick with a trailing space', () => {
    const res = slashCommandSource(providers)(ctx('/dep'));
    const cmd = res?.options[0] as MentionCompletion;
    const view = new EditorView({ state: EditorState.create({ doc: '/dep' }) });
    (cmd.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(view, cmd, 0, 4);
    expect(view.state.doc.toString()).toBe('/deploy');
    expect(view.state.selection.main.anchor).toBe(7);
    view.destroy();

    const conn = slashCommandSource(providers)(ctx('/git'))?.options[0] as MentionCompletion;
    const view2 = new EditorView({ state: EditorState.create({ doc: '/git' }) });
    (conn.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(view2, conn, 0, 4);
    expect(view2.state.doc.toString()).toBe('/gitlab ');
    view2.destroy();
  });
});

function pillLabels(view: EditorView): string[] {
  return Array.from(view.dom.querySelectorAll('.cm-mention-pill[data-mention-kind="connector"]')).map(
    (el) => el.textContent ?? '',
  );
}

describe('connectorPills', () => {
  function mount(doc: string, slugs: string[], extraExts: Extension[] = []): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [connectorPills(() => slugs) as Extension, ...extraExts] }),
      parent: document.body,
    });
    return view;
  }

  it('renders installed "/slug" tokens as pills and leaves unknown slugs as text', () => {
    const view = mount('use /gitlab or /tmp today', ['gitlab']);
    expect(pillLabels(view)).toEqual(['/gitlab']);
    // Atomic ranges consult the plugin's decorations during cursor motion.
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    cursorCharLeft(view);
    view.destroy();
  });

  it('renders nothing when no connectors are installed', () => {
    const view = mount('use /gitlab today', []);
    expect(pillLabels(view)).toEqual([]);
    view.destroy();
  });

  it('reveals the raw token while the caret is inside it', () => {
    const view = mount('use /gitlab now', ['gitlab']);
    expect(pillLabels(view)).toEqual(['/gitlab']);
    view.dispatch({ selection: { anchor: 7 } });
    expect(pillLabels(view)).toEqual([]);
    view.destroy();
  });

  it('atomic ranges fall back to none when the paired plugin is absent', () => {
    const pair = connectorPills(() => ['gitlab']) as unknown as [Extension, Extension];
    const view = new EditorView({
      state: EditorState.create({ doc: 'a /gitlab b', extensions: [pair[1]] }),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    cursorCharLeft(view);
    view.destroy();
  });
});

describe('MarkdownComposer connector wiring', () => {
  it('feeds installed connector slugs to the editor pills and typeahead', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MarkdownComposer ariaLabel="Composer" initialBody="see /gitlab and /trello" />
      </QueryClientProvider>,
    );
    expect(container.querySelector('.cm-content')).not.toBeNull();
    // Only the INSTALLED connector renders as a pill: trello isn't installed.
    const labels = Array.from(
      container.querySelectorAll('.cm-mention-pill[data-mention-kind="connector"]'),
    ).map((el) => el.textContent);
    expect(labels).toEqual(['/gitlab']);
  });
});
