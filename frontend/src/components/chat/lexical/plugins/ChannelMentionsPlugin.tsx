import { useCallback, useMemo, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { COMMAND_PRIORITY_NORMAL, type TextNode } from 'lexical';
import { useUserChannels } from '@/hooks/useChannels';
import { fuzzyMatch } from '@/lib/fuzzy';
import { topK } from '@/lib/topk';
import { Hash, Lock } from 'lucide-react';
import { $createChannelMentionNode } from '../nodes/ChannelMentionNode';
import { TypeaheadMenu } from './TypeaheadMenu';
import { $replaceWithDecoratorAndTrailingSpace } from './typeaheadHelpers';

const MAX_RESULTS = 12;

interface ChannelHit {
  id: string;
  slug: string;
  name: string;
  description?: string;
  isPrivate: boolean;
}

class ChannelMentionOption extends MenuOption {
  readonly channel: ChannelHit;
  constructor(channel: ChannelHit) {
    super(`c-${channel.id}`);
    this.channel = channel;
  }
}

export function ChannelMentionsPlugin() {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const { data: channels = [] } = useUserChannels();

  const options = useMemo<ChannelMentionOption[]>(() => {
    if (query == null) return [];
    const q = query.toLowerCase();
    const hits: ChannelHit[] = channels
      .map((c) => ({
        id: c.channelID,
        slug: c.channelName,
        name: c.channelName,
        description: undefined,
        isPrivate: c.channelType === 'private',
      }))
      .filter((c) => fuzzyMatch(q, c.slug, c.name));
    return topK(hits, MAX_RESULTS, (a, b) => {
      const aPref = a.slug.toLowerCase().startsWith(q) ? 0 : 1;
      const bPref = b.slug.toLowerCase().startsWith(q) ? 0 : 1;
      return aPref - bPref;
    }).map((h) => new ChannelMentionOption(h));
  }, [channels, query]);

  const triggerFn = useBasicTypeaheadTriggerMatch('~', { minLength: 0 });

  const onSelectOption = useCallback(
    (selectedOption: ChannelMentionOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const ch = selectedOption.channel;
        $replaceWithDecoratorAndTrailingSpace(nodeToReplace, $createChannelMentionNode(ch.id, ch.slug));
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<ChannelMentionOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      options={options}
      // See UserMentionsPlugin for the priority rationale.
      commandPriority={COMMAND_PRIORITY_NORMAL}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorElementRef.current ? (
          <TypeaheadMenu
            testId="channel-popup"
            emptyLabel={query?.length ? 'No channels match' : undefined}
            options={options}
            selectedIndex={selectedIndex}
            setHighlightedIndex={setHighlightedIndex}
            selectOptionAndCleanUp={selectOptionAndCleanUp}
            anchorElementRef={anchorElementRef}
            renderRow={(option) => <ChannelRow channel={option.channel} />}
          />
        ) : null
      }
    />
  );
}

function ChannelRow({ channel }: { channel: ChannelHit }) {
  const Icon = channel.isPrivate ? Lock : Hash;
  return (
    <div className="flex items-center gap-2" data-testid="channel-option">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">~{channel.slug}</div>
        {channel.description && (
          <div className="truncate text-xs text-muted-foreground">{channel.description}</div>
        )}
      </div>
    </div>
  );
}
