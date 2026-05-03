import { useCallback, useMemo, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createTextNode, COMMAND_PRIORITY_NORMAL, type TextNode } from 'lexical';
import { useAllUsers } from '@/hooks/useConversations';
import { usePresence } from '@/context/PresenceContext';
import { fuzzyMatch } from '@/lib/fuzzy';
import { topK } from '@/lib/topk';
import { UserAvatar } from '@/components/UserAvatar';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import type { UserStatus } from '@/types';
import { $createMentionNode } from '../nodes/MentionNode';
import { TypeaheadMenu } from './TypeaheadMenu';
import { $replaceWithDecoratorAndTrailingSpace } from './typeaheadHelpers';

const MAX_RESULTS = 12;

class UserMentionOption extends MenuOption {
  readonly suggestion: Suggestion;
  constructor(suggestion: Suggestion) {
    super(keyForSuggestion(suggestion));
    this.suggestion = suggestion;
  }
}

type GroupName = 'all' | 'here';

type Suggestion =
  | { kind: 'user'; id: string; displayName: string; email?: string; avatarURL?: string; userStatus?: UserStatus; online: boolean }
  | { kind: 'group'; group: GroupName };

const GROUP_NAMES: GroupName[] = ['all', 'here'];
const GROUP_DESCRIPTIONS: Record<GroupName, string> = {
  all: 'Notify everyone in this channel',
  here: 'Notify everyone currently online',
};

function keyForSuggestion(s: Suggestion): string {
  return s.kind === 'user' ? `u-${s.id}` : `g-${s.group}`;
}

export function UserMentionsPlugin() {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const { data: users = [] } = useAllUsers();
  const { online } = usePresence();

  const options = useMemo<UserMentionOption[]>(() => {
    if (query == null) return [];
    const q = query.toLowerCase();
    const userMatches: Suggestion[] = users
      .filter((u) => fuzzyMatch(q, u.displayName, u.email ?? ''))
      .map((u) => ({
        kind: 'user' as const,
        id: u.id,
        displayName: u.displayName,
        email: u.email,
        avatarURL: u.avatarURL,
        userStatus: u.userStatus,
        online: online.has(u.id),
      }));
    const ranked = topK(userMatches, MAX_RESULTS, (a, b) => {
      // Prefix matches outrank substring matches; ties broken by online
      // status so present teammates float to the top.
      const aPref = a.kind === 'user' && a.displayName.toLowerCase().startsWith(q) ? 0 : 1;
      const bPref = b.kind === 'user' && b.displayName.toLowerCase().startsWith(q) ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      const aOnline = a.kind === 'user' && a.online ? 0 : 1;
      const bOnline = b.kind === 'user' && b.online ? 0 : 1;
      return aOnline - bOnline;
    });
    // Group mentions (@all / @here) only surface when the user has
    // typed the full keyword. Slack's pattern: a partial "@a" must NOT
    // suggest "@all" — that lets the user type "@alan" without a mid-
    // type @all hovering at the top of the suggestion list. The group
    // name is matched case-insensitively but exactly.
    const groupMatches: Suggestion[] = GROUP_NAMES
      .filter((g) => g === q)
      .map((group) => ({ kind: 'group' as const, group }));
    return [...groupMatches, ...ranked].map((s) => new UserMentionOption(s));
  }, [users, query, online]);

  const triggerFn = useBasicTypeaheadTriggerMatch('@', { minLength: 0 });

  const onSelectOption = useCallback(
    (selectedOption: UserMentionOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const sug = selectedOption.suggestion;
        if (sug.kind === 'user') {
          $replaceWithDecoratorAndTrailingSpace(nodeToReplace, $createMentionNode(sug.id, sug.displayName));
        } else {
          const node = $createTextNode(`@${sug.group} `);
          nodeToReplace?.replace(node);
          node.select(node.getTextContentSize(), node.getTextContentSize());
        }
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<UserMentionOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      options={options}
      // Run the typeahead key handlers at NORMAL priority so they
      // preempt SubmitOnEnter (LOW) when the menu is open. Without
      // this override Lexical iterates same-priority handlers in
      // insertion order and SubmitOnEnter — registered first on
      // mount — wins, sending the message instead of picking the
      // suggestion. (See SubmitOnEnterPlugin for the symmetric note.)
      commandPriority={COMMAND_PRIORITY_NORMAL}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorElementRef.current ? (
          <TypeaheadMenu
            testId="mention-popup"
            emptyLabel={query?.length ? 'No matches' : undefined}
            options={options}
            selectedIndex={selectedIndex}
            setHighlightedIndex={setHighlightedIndex}
            selectOptionAndCleanUp={selectOptionAndCleanUp}
            anchorElementRef={anchorElementRef}
            renderRow={(option) => <MentionRow suggestion={option.suggestion} />}
          />
        ) : null
      }
    />
  );
}

function MentionRow({ suggestion }: { suggestion: Suggestion }) {
  if (suggestion.kind === 'group') {
    return (
      <div className="flex items-center gap-2" data-testid="mention-option">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-semibold text-amber-900">
          @
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">@{suggestion.group}</div>
          <div className="truncate text-xs text-muted-foreground">{GROUP_DESCRIPTIONS[suggestion.group]}</div>
        </div>
      </div>
    );
  }
  // Presence dot lives on the avatar (matching MemberList) instead of
  // hanging off the row's right edge, so the @-mention popup and the
  // member sidebar use the same visual treatment.
  return (
    <div className="flex items-center gap-2" data-testid="mention-option">
      <UserAvatar
        displayName={suggestion.displayName}
        avatarURL={suggestion.avatarURL}
        online={suggestion.online}
        userStatus={suggestion.userStatus}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <div className="truncate font-medium">{suggestion.displayName}</div>
          <UserStatusIndicator status={suggestion.userStatus} />
        </div>
        {suggestion.email && (
          <div className="truncate text-xs text-muted-foreground">{suggestion.email}</div>
        )}
      </div>
    </div>
  );
}
