import { Globe, Lock } from 'lucide-react';

interface ChannelIconProps {
  type: 'public' | 'private';
  className?: string;
  // When provided, overrides the default "Public/Private channel" label.
  // Pass an empty string to mark the icon decorative (the consumer
  // already labels the row).
  ariaLabel?: string;
}

export function ChannelIcon({ type, className, ariaLabel }: ChannelIconProps) {
  const Icon = type === 'private' ? Lock : Globe;
  const label =
    ariaLabel === undefined
      ? type === 'private'
        ? 'Private channel'
        : 'Public channel'
      : ariaLabel;
  return <Icon className={className} aria-label={label || undefined} aria-hidden={!label} />;
}
