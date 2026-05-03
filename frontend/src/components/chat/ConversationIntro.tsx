import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ChannelIcon } from '@/components/ChannelIcon';
import { getInitials, formatLongDate } from '@/lib/format';
import type { Channel } from '@/types';

interface BaseProps {
  className?: string;
}

// ---------- Channel ----------
interface ChannelIntroProps extends BaseProps {
  channel: Channel;
  creatorName?: string;
}

export function ChannelIntro({ channel, creatorName, className }: ChannelIntroProps) {
  const who = creatorName ? `@${creatorName}` : 'Someone';
  return (
    <div
      data-testid="conversation-intro"
      data-intro-kind="channel"
      className={`mb-4 rounded-lg border bg-muted/20 p-4 ${className ?? ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
          <ChannelIcon type={channel.type} className="h-5 w-5 text-muted-foreground" ariaLabel="" />
        </span>
        <h2 className="text-base font-semibold">
          ~{channel.name}
        </h2>
      </div>
      <p className="text-sm text-muted-foreground">
        {who} created this channel on {formatLongDate(channel.createdAt)}. This is
        the very beginning of the <span className="font-medium">{channel.name}</span>{' '}
        channel.
      </p>
      {channel.description && (
        <p className="mt-2 text-sm text-muted-foreground">{channel.description}</p>
      )}
    </div>
  );
}

// ---------- Direct Message (1:1) ----------
interface DMIntroProps extends BaseProps {
  otherDisplayName: string;
  otherAvatarURL?: string;
  online?: boolean;
}

export function DMIntro({ otherDisplayName, otherAvatarURL, online, className }: DMIntroProps) {
  return (
    <div
      data-testid="conversation-intro"
      data-intro-kind="dm"
      className={`mb-4 flex items-start gap-3 rounded-lg border bg-muted/20 p-4 ${className ?? ''}`}
    >
      <span className="relative inline-block shrink-0">
        {/* Keyed on the URL so AvatarImage's load state resets when
            switching to a partner without an avatar — otherwise the
            previous successful image keeps the fallback hidden. */}
        <Avatar key={otherAvatarURL ?? '__none__'} className="h-12 w-12">
          {otherAvatarURL && <AvatarImage src={otherAvatarURL} alt="" />}
          <AvatarFallback>{getInitials(otherDisplayName)}</AvatarFallback>
        </Avatar>
        {online !== undefined && (
          <span
            className={`absolute bottom-0 right-0 h-3 w-3 rounded-full ring-2 ring-background ${
              online ? 'bg-emerald-500' : 'bg-muted-foreground'
            }`}
            aria-label={online ? 'Online' : 'Offline'}
          />
        )}
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{otherDisplayName}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This conversation is just between{' '}
          <span className="font-medium">@{otherDisplayName}</span> and you. Check
          out their profile to learn more about them.
        </p>
      </div>
    </div>
  );
}

// ---------- DM with self ----------
interface SelfDMIntroProps extends BaseProps {
  selfDisplayName: string;
  selfAvatarURL?: string;
}

export function SelfDMIntro({ selfDisplayName, selfAvatarURL, className }: SelfDMIntroProps) {
  return (
    <div
      data-testid="conversation-intro"
      data-intro-kind="self-dm"
      className={`mb-4 flex items-start gap-3 rounded-lg border bg-muted/20 p-4 ${className ?? ''}`}
    >
      <Avatar key={selfAvatarURL ?? '__none__'} className="h-12 w-12 shrink-0">
        {selfAvatarURL && <AvatarImage src={selfAvatarURL} alt="" />}
        <AvatarFallback>{getInitials(selfDisplayName)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{selfDisplayName}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This is your space. Draft messages, list your to-dos, or keep links and
          files handy. You can also talk to yourself here, but please bear in
          mind you'll have to supply both sides of the conversation.
        </p>
      </div>
    </div>
  );
}

// ---------- Group ----------
export interface GroupIntroParticipant {
  id: string;
  displayName: string;
  avatarURL?: string;
}

interface GroupIntroProps extends BaseProps {
  participants: GroupIntroParticipant[];
}

export function GroupIntro({ participants, className }: GroupIntroProps) {
  const mention = formatMentionList(participants.map((p) => p.displayName));
  return (
    <div
      data-testid="conversation-intro"
      data-intro-kind="group"
      className={`mb-4 rounded-lg border bg-muted/20 p-4 ${className ?? ''}`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {participants.map((p) => (
          <span
            key={p.id}
            data-testid="group-intro-participant"
            className="flex items-center gap-1.5 rounded-full bg-background px-2 py-1 text-sm"
          >
            <Avatar className="h-6 w-6">
              {p.avatarURL && <AvatarImage src={p.avatarURL} alt="" />}
              <AvatarFallback className="bg-primary/10 text-[10px]">
                {getInitials(p.displayName)}
              </AvatarFallback>
            </Avatar>
            <span className="font-medium">{p.displayName}</span>
          </span>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        This is the very beginning of your direct message history with {mention}.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        You'll be notified for every new message in this conversation.
      </p>
    </div>
  );
}

// formatMentionList joins display names into a natural-language list with
// @-prefixed mentions and an Oxford comma for 3+ items: "@A, @B and @C".
function formatMentionList(names: string[]): string {
  const tagged = names.map((n) => `@${n}`);
  if (tagged.length === 0) return '';
  if (tagged.length === 1) return tagged[0];
  if (tagged.length === 2) return `${tagged[0]} and ${tagged[1]}`;
  return `${tagged.slice(0, -1).join(', ')} and ${tagged[tagged.length - 1]}`;
}
