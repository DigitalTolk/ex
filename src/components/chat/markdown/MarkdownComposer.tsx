import { forwardRef, memo, useCallback, useMemo } from 'react';
import { useAllUsers } from '@/hooks/useConversations';
import { useQuery } from '@tanstack/react-query';
import { conversationQuery } from '@/lib/conversation-query';
import { useFrequentPeople } from '@/hooks/useFrequentPeople';
import { useChannelMembers, useUserChannels } from '@/hooks/useChannels';
import { usePresenceStore } from '@/stores/presence';
import { useEmojis, useEmojiMap } from '@/hooks/useEmoji';
import { useOptionalAuth } from '@/context/AuthContext';
import { activeStatus } from '@/lib/user-status';
import type { EmojiSkinTone } from '@/lib/emoji-shortcodes';
import { MarkdownEditor, type WysiwygEditorHandle, type ActiveFormat } from './MarkdownEditor';
import type { CompletionProviders } from './extensions/completions';
import type { MemberScope } from './extensions/mentionAutocomplete';
import type { SlashCommand } from './extensions/slashCommands';
import { useConnectors } from '@/hooks/useConnectors';
import { useSkills } from '@/hooks/useAgents';
import { useProjects } from '@/hooks/useProjects';
import { skillPickToken } from '@/lib/picks';
import type { UserChannel } from '@/types';
import { withoutDeactivated } from '@/lib/deactivated';

export type { WysiwygEditorHandle, ActiveFormat };

interface Props {
  initialBody?: string;
  onChange?: (markdown: string) => void;
  onSubmit?: (markdown: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  editorClassName?: string;
  onFocusChange?: (focused: boolean) => void;
  onPasteFiles?: (files: File[]) => void;
  submitOnEnter?: boolean;
  onArrowUpEmpty?: () => boolean;
  // The link shortcut opens the composer's link dialog.
  onLinkShortcut?: () => void;
  // The chat the composer writes in, whose people the @-list puts first: a
  // channel (its members) or a DM (its participants). Edits pass neither and
  // get one flat list.
  mentionChannelId?: string;
  mentionConversationId?: string;
  // A thread reply box: who has written in the thread, ahead of the members.
  mentionThreadIds?: string[];
  // Server-defined slash commands for the "/" popup. Only the main chat
  // composer passes this; edit boxes and thread reply boxes omit it (no popup).
  slashCommands?: () => SlashCommand[];
}

// MarkdownComposer is the production composer: a drop-in for the old Lexical
// WysiwygEditor (identical props + WysiwygEditorHandle) that sources the live
// roster / channel / custom-emoji / skin-tone data from the app's hooks and
// feeds it to the CodeMirror MarkdownEditor's autocomplete. The editor itself
// keeps the document as raw markdown — see MarkdownEditor for the architecture.
const NO_EMOJI_MAP: Record<string, string> = {};

type MentionChannel = Pick<UserChannel, 'channelID' | 'channelName' | 'channelType'>;
const NO_CHANNELS: MentionChannel[] = [];
const selectMentionChannels = (rows: UserChannel[]): MentionChannel[] =>
  rows.map((c) => ({ channelID: c.channelID, channelName: c.channelName, channelType: c.channelType }));

// Memoized: the composer around it re-renders on every keystroke, and its
// props are stable, so the editor and its autocomplete data stay put.
export const MarkdownComposer = memo(forwardRef<WysiwygEditorHandle, Props>(function MarkdownComposer(
  { mentionChannelId, mentionConversationId, mentionThreadIds, slashCommands, ...editorProps },
  ref,
) {
  const { data: users = [] } = useAllUsers();
  const { data: memberRows } = useChannelMembers(mentionChannelId);
  // The DM view has this loaded already: the same query, no new request.
  const { data: conversation } = useQuery(conversationQuery(mentionConversationId));
  // Only what the ~channel typeahead shows: an unread change on any channel
  // rewrites the full rows, which re-rendered the composer for every message
  // arriving anywhere.
  const { data: channels = NO_CHANNELS } = useUserChannels({ select: selectMentionChannels });
  const { data: customEmojis = [] } = useEmojis();
  const { data: emojiMap = NO_EMOJI_MAP } = useEmojiMap();
  const auth = useOptionalAuth();
  const skinTone: EmojiSkinTone = auth?.user?.emojiSkinTone ?? '';
  // "/" typeahead offers the user's INSTALLED connectors — picking one puts
  // an inline "/slug" token in the message that scopes which external
  // services the agent run may use.
  const { data: allConnectors } = useConnectors();
  const installedConnectors = useMemo(
    () =>
      (allConnectors ?? [])
        .filter((c) => c.installed)
        .map((c) => ({ name: c.slug, description: c.title + ' — ' + c.description })),
    [allConnectors],
  );
  // …and the workspace SKILLS: "/weekly-report" attaches that skill's
  // instructions to the agent run this message invokes (works in DMs too).
  // Token = the server's normalization of the skill name.
  const { data: allSkills } = useSkills();
  const skillPicks = useMemo(
    () =>
      (allSkills ?? [])
        .map((s) => ({ name: skillPickToken(s.name), description: s.name + ' — ' + s.description }))
        .filter((s) => s.name !== ''),
    [allSkills],
  );

  // …and PROJECTS (members only — guests can't read them): "/booking-portal"
  // tells the design agent which product's screenshots and notes to copy.
  const { data: allProjects } = useProjects({ enabled: !!auth?.user && auth.user.systemRole !== 'guest' });
  const projectPicks = useMemo(
    () => (allProjects ?? []).map((p) => ({ name: p.key, description: `${p.name} — project design references` })),
    [allProjects],
  );

  // Partition the @-mention list by the chat's people only when we actually
  // know them, or a mid-load empty set would mislabel everyone.
  const memberIds = useMemo<Set<string> | null>(() => {
    if (mentionChannelId) return memberRows ? new Set(memberRows.map((m) => m.userID)) : null;
    if (mentionConversationId) return conversation?.participantIDs ? new Set(conversation.participantIDs) : null;
    return null;
  }, [mentionChannelId, memberRows, mentionConversationId, conversation]);
  const memberScope: MemberScope = mentionChannelId ? 'channel' : 'conversation';
  const threadIds = useMemo(() => (mentionThreadIds ? new Set(mentionThreadIds) : null), [mentionThreadIds]);
  // Who the writer mentions and messages most comes first in each section.
  const frequent = useFrequentPeople(!!auth?.user);

  const completionProviders = useMemo<CompletionProviders>(
    () => ({
      // Nobody can mention a deactivated account.
      users: () =>
        withoutDeactivated(users).map((u) => ({
          id: u.id,
          displayName: u.displayName,
          email: u.email,
          avatarURL: u.avatarURL,
          statusEmoji: activeStatus(u.userStatus)?.emoji,
        })),
      // Read when the @-list opens, never subscribed: a presence change
      // anywhere used to re-render every open composer.
      online: () => usePresenceStore.getState().online,
      memberIds: () => memberIds,
      memberScope: () => memberScope,
      threadIds: () => threadIds,
      frequent: () => frequent,
      channels: () => channels,
      customEmojis: () => customEmojis,
      skinTone: () => skinTone,
      commands: slashCommands,
      connectors: () => installedConnectors,
      skills: () => skillPicks,
      projects: () => projectPicks,
    }),
    [
      users,
      memberIds,
      memberScope,
      threadIds,
      frequent,
      channels,
      customEmojis,
      skinTone,
      slashCommands,
      installedConnectors,
      skillPicks,
      projectPicks,
    ],
  );

  const customEmojiMap = useCallback(() => emojiMap, [emojiMap]);

  return (
    <MarkdownEditor
      ref={ref}
      {...editorProps}
      completionProviders={completionProviders}
      customEmojiMap={customEmojiMap}
    />
  );
}));
