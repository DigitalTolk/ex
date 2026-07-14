import {
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { MentionCompletion } from './optionRender';

// CodeMirror completion source for slash commands (/mstmeetings …). Commands
// come from the server (`GET /api/v1/commands` — only configured integrations
// are listed), so an empty provider simply never opens the popup. The trigger
// only fires when "/" starts the message: a command is the whole message, not
// inline syntax, so "a/b" or mid-text "/" must never pop the menu.

export interface SlashCommand {
  name: string;
  description: string;
}

export interface SlashCommandProviders {
  commands?: () => SlashCommand[];
}

// Replace the matched range with the full command; the send handler runs it.
function applyCommand(text: string) {
  return (view: EditorView, _completion: unknown, from: number, to: number) => {
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  };
}

export function slashCommandSource(providers: SlashCommandProviders): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\/[\w-]*/);
    if (!before || before.from !== 0) return null;
    const commands = providers.commands?.() ?? [];
    const query = before.text.slice(1).toLowerCase();
    const options = commands
      .filter((c) => c.name.toLowerCase().startsWith(query))
      .map((c): MentionCompletion => ({
        label: `/${c.name}`,
        detail: c.description,
        type: 'keyword',
        apply: applyCommand(`/${c.name}`),
        meta: { kind: 'command', name: c.name, description: c.description },
      }));
    if (options.length === 0) return null;
    return { from: before.from, to: before.to, options, filter: false };
  };
}
