import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { channelName, channelNameDraft } from '@/lib/channel-name';
import { validateChannelName } from '@/lib/limits';
import { queryKeys } from '@/lib/query-keys';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

const NAME_CHECK_DEBOUNCE_MS = 250;

// Whether a channel may be called `name`. `channelId` is the channel being
// renamed, whose own name counts as free. A failed check reads as free: the
// server still refuses a taken name on submit.
function useChannelNameAvailable(name: string, channelId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.channelNameAvailable(name, channelId),
    queryFn: async ({ signal }) => {
      const query = channelId ? `?channel=${encodeURIComponent(channelId)}` : '';
      const res = await apiFetch<{ available: boolean } | undefined>(
        `/api/v1/channel-names/${encodeURIComponent(name)}${query}`,
        { signal },
      );
      return res?.available !== false;
    },
    enabled,
    retry: false,
    staleTime: 10_000,
  });
}

// useChannelName holds the field: `name` is what it shows — a draft that may
// end in a hyphen or, mid-composition, raw text — and `finalName` the channel
// it stands for. A name another channel holds shows as taken while it is
// typed; the server's answer on submit (`taken`) covers a name someone took
// in between. Renaming starts from the channel's name (`initial`), which is
// never reported as taken.
export function useChannelName({ initial = '', channelId = '' }: { initial?: string; channelId?: string } = {}) {
  const [name, setName] = useState(initial);
  // The last name the server answered "already exists" for.
  const [takenName, setTakenName] = useState<string | null>(null);
  const locale = navigator.language;
  const finalName = channelName(name, locale);
  const invalid = validateChannelName(finalName)?.message ?? null;
  const checked = useDebouncedValue(finalName, NAME_CHECK_DEBOUNCE_MS);
  const { data: available } = useChannelNameAvailable(
    checked,
    channelId,
    !invalid && checked === finalName && checked !== '' && checked !== initial,
  );
  const taken = finalName === takenName || (available === false && checked === finalName);
  const nameError = taken ? `~${finalName} already exists` : invalid;

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
