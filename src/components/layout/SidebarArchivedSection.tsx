import { useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { slugify } from '@/lib/format';
import type { UserChannel } from '@/types';
import { ChannelRow } from './ChannelRow';

// SidebarArchivedSection lists archived (read-only) channels under their own
// foldable heading, below every other section.
export function SidebarArchivedSection({
  channels,
  open,
  onToggle,
  onClose,
}: {
  channels: UserChannel[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { pathname } = useLocation();
  return (
    <div className="relative mt-2" data-testid="sidebar-group-archived">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={open}
        data-testid="sidebar-group-toggle-archived"
        className="flex flex-1 items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold text-gray-400 hover:bg-white/5 mobile:h-12 mobile:px-3 mobile:py-0 mobile:text-base"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="truncate">Archived</span>
      </div>
      <div className="space-y-1 opacity-60">
        {channels
          // Folded, it still shows the archived channel being viewed so the
          // open row doesn't vanish from under the user.
          .filter((ch) => open || pathname === `/channel/${slugify(ch.channelName)}`)
          .map((ch) => (
            <ChannelRow key={`archived-${ch.channelID}`} channel={ch} hasUnread={false} onClose={onClose} />
          ))}
      </div>
    </div>
  );
}
