import { forwardRef, useMemo } from 'react';
import { useAllUsers } from '@/hooks/useConversations';
import { useChannelMembers, useUserChannels } from '@/hooks/useChannels';
import { usePresence } from '@/context/PresenceContext';
import { useEmojis } from '@/hooks/useEmoji';
import { useOptionalAuth } from '@/context/AuthContext';
import type { EmojiSkinTone } from '@/lib/emoji-shortcodes';
import { MarkdownEditor, type WysiwygEditorHandle, type ActiveFormat } from './MarkdownEditor';
import type { CompletionProviders } from './extensions/completions';

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
  // Channel the composer targets (when it's a channel). Enables the @-mention
  // member / special / not-in-channel partitioning. Omitted for DMs and edits.
  mentionChannelId?: string;
}

// MarkdownComposer is the production composer: a drop-in for the old Lexical
// WysiwygEditor (identical props + WysiwygEditorHandle) that sources the live
// roster / channel / custom-emoji / skin-tone data from the app's hooks and
// feeds it to the CodeMirror MarkdownEditor's autocomplete. The editor itself
// keeps the document as raw markdown — see MarkdownEditor for the architecture.
export const MarkdownComposer = forwardRef<WysiwygEditorHandle, Props>(function MarkdownComposer(
  { mentionChannelId, ...editorProps },
  ref,
) {
  const { data: users = [] } = useAllUsers();
  const { data: memberRows } = useChannelMembers(mentionChannelId);
  const { online } = usePresence();
  const { data: channels = [] } = useUserChannels();
  const { data: customEmojis = [] } = useEmojis();
  const auth = useOptionalAuth();
  const skinTone: EmojiSkinTone = auth?.user?.emojiSkinTone ?? '';

  // Partition the @-mention list by channel membership only when we actually
  // know the roster — otherwise a mid-load empty set would mislabel everyone.
  const memberIds = useMemo<Set<string> | null>(
    () => (mentionChannelId && memberRows ? new Set(memberRows.map((m) => m.userID)) : null),
    [mentionChannelId, memberRows],
  );

  const completionProviders = useMemo<CompletionProviders>(
    () => ({
      users: () => users.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, avatarURL: u.avatarURL })),
      online: () => online,
      memberIds: () => memberIds,
      channels: () =>
        channels.map((c) => ({ channelID: c.channelID, channelName: c.channelName, channelType: c.channelType })),
      customEmojis: () => customEmojis,
      skinTone: () => skinTone,
    }),
    [users, online, memberIds, channels, customEmojis, skinTone],
  );

  return <MarkdownEditor ref={ref} {...editorProps} completionProviders={completionProviders} />;
});
