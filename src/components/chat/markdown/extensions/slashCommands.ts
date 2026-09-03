import {
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
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
  // Installed connectors — "/slug" picks an external service for the message.
  // Unlike commands, connector tokens are inline: they complete at any
  // word-start "/" and the rest of the message follows.
  connectors?: () => SlashCommand[];
}

// Grouped-menu headers (same chrome as the @-mention popup's
// cm-mention-section rows): "Commands" and "Connectors" today, more groups
// as the "/" menu grows.
function mkSection(name: string, rank: number): CompletionSection {
  return {
    name,
    rank,
    header: () => {
      const el = document.createElement('div');
      el.className = 'cm-mention-section';
      el.textContent = name;
      return el;
    },
  };
}
const SECTION_COMMANDS = mkSection('Commands', 0);
const SECTION_CONNECTORS = mkSection('Connectors', 1);

// Replace the matched range with the full command; the send handler runs it.
function applyCommand(text: string) {
  return (view: EditorView, _completion: unknown, from: number, to: number) => {
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  };
}

export function slashCommandSource(providers: SlashCommandProviders): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\/[\w-]*/);
    if (!before) return null;
    // Word-start only: "a/b", URLs and ratios never pop the menu. A "/" that
    // matched with a non-space directly before it is mid-word — bail.
    if (before.from > 0) {
      const prev = context.state.sliceDoc(before.from - 1, before.from);
      if (!/\s/.test(prev)) return null;
    }
    const query = before.text.slice(1).toLowerCase();
    const options: MentionCompletion[] = [];
    // The popup is a sectioned menu (like a command palette): each group gets
    // a muted header row. rank keeps a stable group order as more sections
    // are added over time.
    // Integration commands are whole-message: only at position 0.
    if (before.from === 0) {
      for (const c of providers.commands?.() ?? []) {
        if (!c.name.toLowerCase().startsWith(query)) continue;
        options.push({
          label: `/${c.name}`,
          detail: c.description,
          type: 'keyword',
          section: SECTION_COMMANDS,
          apply: applyCommand(`/${c.name}`),
          meta: { kind: 'command', name: c.name, description: c.description },
        });
      }
    }
    // Connector picks are inline: anywhere a word starts with "/". Inserting
    // adds a trailing space so typing flows straight into the ask.
    for (const c of providers.connectors?.() ?? []) {
      if (!c.name.toLowerCase().startsWith(query)) continue;
      options.push({
        label: `/${c.name}`,
        detail: c.description,
        type: 'keyword',
        section: SECTION_CONNECTORS,
        apply: applyCommand(`/${c.name} `),
        meta: { kind: 'command', name: c.name, description: c.description },
      });
    }
    if (options.length === 0) return null;
    return { from: before.from, to: before.to, options, filter: false };
  };
}
