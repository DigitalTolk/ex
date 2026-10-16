import { describe, it, expect, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CompletionContext, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cursorCharLeft } from '@codemirror/commands';
import { slashCommandSource } from '@/components/chat/markdown/extensions/slashCommands';
import { connectorPills } from '@/components/chat/markdown/extensions/mentionPills';
import { MarkdownComposer } from '@/components/chat/markdown/MarkdownComposer';
import { MarkdownEditor } from '@/components/chat/markdown/MarkdownEditor';
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
let mockAuth: { user: { systemRole: string } } | null = null;
vi.mock('@/context/AuthContext', async (orig) => ({
  ...(await orig<typeof import('@/context/AuthContext')>()),
  useOptionalAuth: () => mockAuth,
}));
const projectsEnabled = vi.hoisted(() => [] as (boolean | undefined)[]);
vi.mock('@/hooks/useProjects', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useProjects')>()),
  useProjects: (opts: { enabled?: boolean } = {}) => {
    projectsEnabled.push(opts.enabled);
    return { data: opts.enabled ? [{ key: 'acme-portal', name: 'Acme Portal' }] : undefined };
  },
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
vi.mock('@/hooks/useAgents', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useAgents')>()),
  useSkills: () => ({
    data: [
      { id: 'sk1', name: 'Weekly Report', description: 'digest of the week' },
      { id: 'sk2', name: '---', description: 'unpickable name normalizes to nothing' },
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
  skills: () => [{ name: 'weekly-report', description: 'Weekly Report — digest' }],
  projects: () => [{ name: 'acme-portal', description: 'Acme Portal — project design references' }],
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

  it('offers commands only as the whole message, connectors and skills anywhere', () => {
    const atStart = slashCommandSource(providers)(ctx('/'));
    expect(atStart?.options.map((o) => o.label)).toEqual([
      '/deploy',
      '/standup',
      '/gitlab',
      '/trello',
      '/weekly-report',
      '/acme-portal',
    ]);

    const midMessage = slashCommandSource(providers)(ctx('check /'));
    expect(midMessage?.options.map((o) => o.label)).toEqual(['/gitlab', '/trello', '/weekly-report', '/acme-portal']);

    const projectOnly = slashCommandSource(providers)(ctx('@design /acm'));
    expect(projectOnly?.options.map((o) => o.label)).toEqual(['/acme-portal']);
    const pick = projectOnly?.options[0] as MentionCompletion;
    const pv = new EditorView({ state: EditorState.create({ doc: '@design /acm' }) });
    (pick.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(pv, pick, 8, 12);
    expect(pv.state.doc.toString()).toBe('@design /acme-portal ');
    pv.destroy();

    const skillsOnly = slashCommandSource(providers)(ctx('do the /week'));
    expect(skillsOnly?.options.map((o) => o.label)).toEqual(['/weekly-report']);

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

describe('MarkdownComposer project wiring', () => {
  function mountComposer(body: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MarkdownComposer ariaLabel="Composer" initialBody={body} />
      </QueryClientProvider>,
    );
  }
  const pills = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.cm-mention-pill[data-mention-kind="connector"]')).map((el) => el.textContent);

  it('offers projects to members and renders their picks as pills', () => {
    mockAuth = { user: { systemRole: 'member' } };
    projectsEnabled.length = 0;
    const { container } = mountComposer('@design /acme-portal and /gitlab');
    expect(projectsEnabled.at(-1)).toBe(true);
    expect(pills(container)).toEqual(['/acme-portal', '/gitlab']);
  });

  it('lists projects in the live "/" menu', async () => {
    mockAuth = { user: { systemRole: 'member' } };
    const { container } = mountComposer('');
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    act(() => {
      view.dispatch({ changes: { from: 0, insert: '/acm' }, selection: { anchor: 4 } });
      startCompletion(view);
    });
    await waitFor(() => expect(currentCompletions(view.state).map((c) => c.label)).toEqual(['/acme-portal']));
  });

  it('never asks for projects as a guest or signed out', () => {
    mockAuth = { user: { systemRole: 'guest' } };
    projectsEnabled.length = 0;
    const { container } = mountComposer('/acme-portal');
    expect(projectsEnabled.at(-1)).toBe(false);
    expect(pills(container)).toEqual([]);
    mockAuth = null;
    mountComposer('x');
    expect(projectsEnabled.at(-1)).toBe(false);
  });
});

describe('MarkdownEditor without a projects provider', () => {
  async function openMenu(el: React.ReactElement) {
    const { container } = render(el);
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    act(() => {
      view.dispatch({ changes: { from: 0, insert: '/' }, selection: { anchor: 1 } });
      startCompletion(view);
    });
    return view;
  }

  it('offers no project picks when none are provided', async () => {
    const view = await openMenu(
      <MarkdownEditor ariaLabel="E" completionProviders={{ ...providers, projects: undefined } as never} />,
    );
    await waitFor(() => expect(currentCompletions(view.state).map((c) => c.label)).toContain('/gitlab'));
    expect(currentCompletions(view.state).map((c) => c.label)).not.toContain('/acme-portal');
  });

  it('opens no menu at all without providers', async () => {
    const view = await openMenu(<MarkdownEditor ariaLabel="E" />);
    await act(async () => {});
    expect(currentCompletions(view.state)).toEqual([]);
  });
});
