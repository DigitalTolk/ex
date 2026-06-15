import { autocompletion } from '@codemirror/autocomplete';
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

export function composerAutocomplete(providers: CompletionProviders) {
  return autocompletion({
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
  });
}
