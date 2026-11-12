import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  currentCompletions,
  selectedCompletionIndex,
  setSelectedCompletion,
  type Completion,
} from '@codemirror/autocomplete';
import { Prec, type EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import {
  userMentionSource,
  channelMentionSource,
  type MentionProviders,
} from './mentionAutocomplete';
import { emojiSource, type EmojiProviders } from './emojiAutocomplete';
import { slashCommandSource, type SlashCommandProviders } from './slashCommands';
import { renderMentionOption } from './optionRender';
import { deviceKind } from '@/lib/device';
import { numberedShortcut, numberedShortcutLabel } from '@/lib/platform';

// Single CodeMirror autocompletion instance combining every composer source:
// @-mentions, ~-channels, :emoji: and /commands. CM6 merges sibling
// `autocompletion()` configs unpredictably, so the editor installs exactly one
// with all sources.
export type CompletionProviders = MentionProviders & EmojiProviders & SlashCommandProviders;

// Hovering an option makes it the *selected* option, so the mouse and the
// keyboard share a single selection. Without this, resting the pointer over the
// open list left the keyboard's aria-selected highlight hidden and arrow-key
// navigation looked broken ("the mouse blocks it") — the selection was moving,
// just invisibly. Each option <li> carries an id of the form `…-<index>`
// (CodeMirror's own click handler relies on the same shape), so we map the
// hovered row back to its completion index and select it.
const hoverSelect = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    private readonly onMove: (e: PointerEvent) => void;
    constructor(view: EditorView) {
      this.view = view;
      this.onMove = (e) => {
        const target = e.target as HTMLElement | null;
        const li = target?.closest?.('.cm-tooltip-autocomplete li[id]') as HTMLElement | null;
        if (!li) return;
        const match = /-(\d+)$/.exec(li.id);
        if (!match) return;
        const index = Number(match[1]);
        if (selectedCompletionIndex(this.view.state) === index) return;
        this.view.dispatch({ effects: setSelectedCompletion(index) });
      };
      view.dom.addEventListener('pointermove', this.onMove);
    }
    destroy() {
      this.view.dom.removeEventListener('pointermove', this.onMove);
    }
  },
);

// ⌘1 to ⌘9 (Ctrl elsewhere) accept the first nine options of the open
// typeahead, so a known pick is one chord away. While the typeahead is open the
// chord always belongs to it, even past the end of a short list, so a slip
// never reaches the browser or shell (which would switch tabs). With nothing
// open it passes through untouched.
export function acceptNumberedCompletion(n: number) {
  return (view: EditorView): boolean => {
    if (completionStatus(view.state) !== 'active') return false;
    if (n <= currentCompletions(view.state).length) {
      view.dispatch({ effects: setSelectedCompletion(n - 1) });
      acceptCompletion(view);
    }
    return true;
  };
}

// Read off the keydown rather than a `Mod-1` keymap: CodeMirror maps Mod to
// Cmd only where navigator.platform says Mac, so an iPad with a keyboard would
// want Ctrl while the hint (and the search's ⌘K) say ⌘.
const numberedKeys = EditorView.domEventHandlers({
  keydown: (event, view) => {
    const n = numberedShortcut(event, navigator.userAgent);
    if (n === null || !acceptNumberedCompletion(n)(view)) return false;
    event.preventDefault();
    return true;
  },
});

// renderOption draws the rich row, plus the ⌘1 to ⌘9 hint on the first nine
// rows where there is a keyboard to press it with.
export function renderOption(completion: Completion, state: EditorState): Node | null {
  const row = renderMentionOption(completion);
  if (!row || deviceKind() === 'touch') return row;
  const index = currentCompletions(state).indexOf(completion);
  if (index < 0 || index >= 9) return row;
  const hint = document.createElement('kbd');
  hint.className = 'cm-option-key';
  hint.textContent = numberedShortcutLabel(index + 1, navigator.userAgent);
  row.appendChild(hint);
  return row;
}

export function composerAutocomplete(providers: CompletionProviders) {
  return [
    autocompletion({
      override: [
        userMentionSource(providers),
        channelMentionSource(providers),
        emojiSource(providers),
        slashCommandSource(providers),
      ],
      closeOnBlur: true,
      icons: false,
      // Render a rich custom row (avatar / channel icon / large emoji + text
      // column) per option; the default label/detail are hidden in the theme.
      addToOptions: [{ render: renderOption, position: 20 }],
    }),
    // Tab accepts the highlighted option while the typeahead is open —
    // Slack/IDE muscle memory alongside the default Enter. acceptCompletion
    // returns false when no completion is active, so Tab falls through to
    // its normal behavior (focus navigation) everywhere else. Prec.high so a
    // future lower-precedence Tab binding (e.g. indentation) can't shadow it
    // while the popup is open.
    Prec.high(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
    Prec.high(numberedKeys),
    hoverSelect,
  ];
}
