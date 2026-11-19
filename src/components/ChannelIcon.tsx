import { Globe, Lock } from 'lucide-react';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { channelEmoji } from '@/lib/channel-icon';

interface ChannelIconProps {
  type: 'public' | 'private';
  // The channel's own emoji, drawn in place of the globe or lock. A private
  // channel with one is marked private beside its name (PrivateChannelMark):
  // the emoji replaces the lock, never the fact.
  icon?: string;
  className?: string;
  // When provided, overrides the default "Public/Private channel" label.
  // Pass an empty string to mark the icon decorative (the consumer
  // already labels the row).
  ariaLabel?: string;
}

export function ChannelIcon({ type, icon, className, ariaLabel }: ChannelIconProps) {
  const label =
    ariaLabel === undefined
      ? type === 'private'
        ? 'Private channel'
        : 'Public channel'
      : ariaLabel;
  const emoji = channelEmoji(icon);
  if (emoji) {
    return (
      <span
        role={label ? 'img' : undefined}
        aria-label={label || undefined}
        aria-hidden={!label}
        className={`inline-flex items-center justify-center ${className ?? ''}`}
        data-testid="channel-emoji"
      >
        <EmojiGlyph emoji={emoji} size="md" />
      </span>
    );
  }
  const Icon = type === 'private' ? Lock : Globe;
  return <Icon className={className} aria-label={label || undefined} aria-hidden={!label} />;
}

// PrivateChannelMark is the small lock that follows a private channel's name
// when its own emoji has taken the lock's place.
export function PrivateChannelMark({ type, icon, className = '' }: { type: 'public' | 'private'; icon?: string; className?: string }) {
  if (type !== 'private' || !channelEmoji(icon)) return null;
  return <Lock className={`h-3 w-3 shrink-0 opacity-60 ${className}`} aria-label="Private" data-testid="channel-private-mark" />;
}
