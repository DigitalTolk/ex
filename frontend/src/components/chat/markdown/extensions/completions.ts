import {
  autocompletion,
  selectedCompletionIndex,
  setSelectedCompletion,
} from '@codemirror/autocomplete';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import {
  userMentionSource,
  channelMentionSource,
  type MentionProviders,
} from './mentionAutocomplete';
import { emojiSource, type EmojiProviders } from './emojiAutocomplete';
import { renderMentionOption } from './optionRender';

// Single CodeMirror autocompletion instance combining every composer source:
// @-mentions, ~-channels and :emoji:. CM6 merges sibling `autocompletion()`
// configs unpredictably, so the editor installs exactly one with all sources.
export type CompletionProviders = MentionProviders & EmojiProviders;

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

export function composerAutocomplete(providers: CompletionProviders) {
  return [
    autocompletion({
      override: [
        userMentionSource(providers),
        channelMentionSource(providers),
        emojiSource(providers),
      ],
      closeOnBlur: true,
      icons: false,
      // Render a rich custom row (avatar / channel icon / large emoji + text
      // column) per option; the default label/detail are hidden in the theme.
      addToOptions: [{ render: renderMentionOption, position: 20 }],
    }),
    hoverSelect,
  ];
}
