import { useState } from 'react';
import { channelName, channelNameDraft } from '@/lib/channel-name';
import { validateChannelName } from '@/lib/limits';

// useChannelName holds the field: `name` is what it shows — a draft that may
// end in a hyphen or, mid-composition, raw text — and `finalName` the channel
// it stands for.
export function useChannelName() {
  const [name, setName] = useState('');
  // The last name the server answered "already exists" for.
  const [takenName, setTakenName] = useState<string | null>(null);
  const locale = navigator.language;
  const finalName = channelName(name, locale);
  const nameError =
    finalName === takenName
      ? `~${finalName} already exists`
      : (validateChannelName(finalName)?.message ?? null);

  // Rewrites the field into a channel name. Giving a controlled input a
  // different value moves its caret to the end, so the caret is put back
  // after what the text before it became.
  function rewriteName(input: HTMLInputElement) {
    const typed = input.value;
    const draft = channelNameDraft(typed, locale);
    if (draft !== typed) {
      // A text input always has a selection; only other input types have none.
      const caret = channelNameDraft(typed.slice(0, input.selectionStart!), locale).length;
      input.value = draft;
      input.setSelectionRange(caret, caret);
    }
    setName(draft);
  }

  return {
    finalName,
    nameError,
    setName,
    taken: (submitted: string) => setTakenName(submitted),
    reset: () => {
      setName('');
      setTakenName(null);
    },
    inputProps: {
      value: name,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        // Mid-composition (a dead key, an IME) a rewrite would break the
        // character being composed; compositionend rewrites it.
        if ((e.nativeEvent as InputEvent).isComposing) {
          setName(e.currentTarget.value);
          return;
        }
        rewriteName(e.currentTarget);
      },
      onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement>) => rewriteName(e.currentTarget),
      onBlur: () => setName(finalName),
    },
  };
}
