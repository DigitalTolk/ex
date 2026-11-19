import { NavLink, useLocation } from 'react-router-dom';
import { BookUser, FilePenLine, MessagesSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useDrafts } from '@/hooks/useDrafts';
import { useUserState } from '@/hooks/useUserState';

// Same row geometry (px-2 py-1.5) as the channel rows below them, so the eye
// doesn't catch on a height bump.
function pageLinkClass(active: boolean): string {
  return `relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors mobile:h-12 mobile:px-3 mobile:py-0 mobile:text-base ${
    active
      ? 'bg-sidebar-accent text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
      : 'text-gray-300 hover:bg-white/10 hover:text-white'
  }`;
}

// Thread replies live in Threads (bold, with a count of the threads you follow
// that have unread replies) and in Activity; a channel or DM row never marks
// itself for them, the way Slack keeps threads out of the channel list. One
// lookup: the server's unread markers in the user state, one per thread, which
// this keeps loaded (see useUnreadThreadIDs).
function useUnreadThreadCount(): number {
  const { data: userState } = useUserState();
  return userState?.threadNotifications?.length ?? 0;
}

// The phone list's top-level pages, above its channels and DMs (the desktop
// has them on the icon rail). Activity has its own tab on a phone, and the AI
// hub isn't built for a phone yet, so it has no entry here.
export function SidebarPageLinks({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  const unreadThreads = useUnreadThreadCount();
  const { data: drafts } = useDrafts();
  const draftCount = drafts?.length ?? 0;
  const directoryActive = pathname === '/directory' || pathname.startsWith('/directory/');

  return (
    <>
      <NavLink to="/threads" onClick={onClose} className={({ isActive }) => pageLinkClass(isActive)}>
        <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className={unreadThreads > 0 ? 'font-bold text-white' : ''} data-testid="threads-nav-label">
          Threads
        </span>
        {unreadThreads > 0 && (
          <Badge variant="brand" className="ml-auto text-xs" data-testid="threads-unread-badge">
            {unreadThreads > 99 ? '99+' : unreadThreads}
          </Badge>
        )}
      </NavLink>

      <NavLink to="/directory/channels" onClick={onClose} className={() => pageLinkClass(directoryActive)}>
        <BookUser className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Directory</span>
      </NavLink>

      <NavLink to="/drafts" onClick={onClose} className={({ isActive }) => pageLinkClass(isActive)}>
        <FilePenLine className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Drafts</span>
        {draftCount > 0 && (
          <Badge variant="brand" className="ml-auto text-xs">
            {draftCount > 99 ? '99+' : draftCount}
          </Badge>
        )}
      </NavLink>
    </>
  );
}
