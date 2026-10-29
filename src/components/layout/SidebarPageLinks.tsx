import { Link, NavLink, useLocation } from 'react-router-dom';
import { BookUser, Bot, FilePenLine, MessagesSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useUnread } from '@/context/UnreadContext';
import { useDrafts } from '@/hooks/useDrafts';
import { useIsMobile } from '@/hooks/useIsMobile';
import { unreadThreadIDs } from '@/hooks/useThreads';
import { useUserState } from '@/hooks/useUserState';
import { AI_HUB_HOME, isAiHubPath } from '@/lib/ai-hub';

// Same row geometry (px-2 py-1.5) as the channel rows below them, so the eye
// doesn't catch on a height bump.
function pageLinkClass(active: boolean): string {
  return `relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors mobile:h-12 mobile:px-3 mobile:py-0 mobile:text-base ${
    active
      ? 'bg-sidebar-accent text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
      : 'text-gray-300 hover:bg-white/10 hover:text-white'
  }`;
}

// Thread replies live in Threads (bold when any thread you follow has unread
// replies) and in Activity; a channel or DM row never marks itself for them,
// the way Slack keeps threads out of the channel list. One lookup: the unread
// markers in the user state, which this keeps loaded.
function useHasThreadUpdates(): boolean {
  const { unreadThreadNotifications } = useUnread();
  const { data: userState } = useUserState();
  return unreadThreadIDs(userState?.threadNotifications, unreadThreadNotifications).size > 0;
}

// The sidebar's top-level pages, above the channel/DM list. Activity has its
// own sidebar mode (the Home / Activity switch above the sidebar).
export function SidebarPageLinks({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  const hasThreadUpdates = useHasThreadUpdates();
  const { data: drafts } = useDrafts();
  const draftCount = drafts?.length ?? 0;
  const directoryActive = pathname === '/directory' || pathname.startsWith('/directory/');
  // The AI hub entry is one link for three routes, so its active state is
  // ours to compute — NavLink would only match /agents.
  const aiHubActive = isAiHubPath(pathname);
  // The AI hub isn't built for a phone yet, so the entry stays off there.
  const isMobile = useIsMobile();

  return (
    <>
      <NavLink to="/threads" onClick={onClose} className={({ isActive }) => pageLinkClass(isActive)}>
        <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className={hasThreadUpdates ? 'font-bold text-white' : ''} data-testid="threads-nav-label">
          Threads
        </span>
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

      {/* One entry for the whole AI hub — Agents, Skills and Connectors
          are tabs inside it (AiHubLayout). Lit for all three routes. */}
      {!isMobile && (
        <Link
          to={AI_HUB_HOME}
          onClick={onClose}
          aria-current={aiHubActive ? 'page' : undefined}
          className={pageLinkClass(aiHubActive)}
        >
          <Bot className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Agents</span>
        </Link>
      )}
    </>
  );
}
