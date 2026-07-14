import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext, startCompletion, currentCompletions, type CompletionResult } from '@codemirror/autocomplete';
import { slashCommandSource, type SlashCommandProviders } from './slashCommands';
import { composerAutocomplete, type CompletionProviders } from './completions';

const COMMANDS = [
  { name: 'mstmeetings', description: 'Start a Microsoft Teams meeting' },
  { name: 'remind', description: 'Set a reminder' },
];

const providers: SlashCommandProviders = { commands: () => COMMANDS };

function ctx(doc: string, pos = doc.length): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), pos, false);
}

// The source is synchronous — narrow away the Promise arm of CompletionSource.
function run(p: SlashCommandProviders, context: CompletionContext): CompletionResult | null {
  return slashCommandSource(p)(context) as CompletionResult | null;
}

describe('slashCommandSource', () => {
  it('offers every command on a bare "/" at the start of the message', () => {
    const result = run(providers, ctx('/'))!;
    expect(result.from).toBe(0);
    expect(result.options.map((o) => o.label)).toEqual(['/mstmeetings', '/remind']);
    expect(result.filter).toBe(false);
  });

  it('filters by typed prefix, case-insensitively', () => {
    const result = run(providers, ctx('/MST'))!;
    expect(result.options.map((o) => o.label)).toEqual(['/mstmeetings']);
  });

  it('does not trigger without a leading "/"', () => {
    expect(run(providers, ctx('hello'))).toBeNull();
  });

  it('does not trigger when "/" is not at the start of the message', () => {
    expect(run(providers, ctx('hi /mst'))).toBeNull();
  });

  it('does not trigger when no command matches the prefix', () => {
    expect(run(providers, ctx('/zz'))).toBeNull();
  });

  it('does not trigger when the provider is absent (no server commands)', () => {
    expect(run({}, ctx('/'))).toBeNull();
  });

  it('applying a completion replaces the prefix with the full command', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '/mst', selection: { anchor: 4 } }),
    });
    const result = run(providers, ctx('/mst'))!;
    const option = result.options[0];
    (option.apply as (v: EditorView, c: unknown, from: number, to: number) => void)(view, option, 0, 4);
    expect(view.state.doc.toString()).toBe('/mstmeetings');
    expect(view.state.selection.main.anchor).toBe('/mstmeetings'.length);
    view.destroy();
    host.remove();
  });

  it('opens in the live composer popup with the rendered command row', async () => {
    const full: CompletionProviders = {
      users: () => [],
      online: () => new Set(),
      memberIds: () => null,
      channels: () => [],
      customEmojis: () => [],
      skinTone: () => '',
      commands: () => COMMANDS,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '/mst', selection: { anchor: 4 }, extensions: [composerAutocomplete(full)] }),
    });
    startCompletion(view);
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).some((c) => c.label === '/mstmeetings')).toBe(true);
      const title = view.dom.querySelector('.cm-tooltip-autocomplete .cm-option-title');
      expect(title?.textContent).toBe('/mstmeetings');
    });
    view.destroy();
    host.remove();
  });
});
