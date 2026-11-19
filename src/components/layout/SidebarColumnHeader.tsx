import { memo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookUser, FolderPlus, MessageSquarePlus, Plus, SquarePlus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CreateChannelDialog } from '@/components/channels/CreateChannelDialog';
import { useAuth } from '@/context/AuthContext';
import { isGuest } from '@/lib/roles';
import { requestAddCategory } from '@/stores/sidebar-add-category';
import { setSidebarMode } from '@/stores/sidebar-mode';

// SidebarColumnHeader tops the sidebar's list: on the left whatever the list
// offers (the server's name over the channel list, Activity's name), and the
// "+" that starts something new. Level with the top bar, and the window
// drags by it in the desktop app.
export const SidebarColumnHeader = memo(function SidebarColumnHeader({
  children,
  onNavigate,
}: {
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const go = (to: string) => {
    navigate(to);
    onNavigate?.();
  };
  return (
    <div
      className="flex h-12 shrink-0 items-center justify-between gap-2 px-3 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]"
      data-sidebar-header="true"
      data-testid="sidebar-column-header"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Create new"
          title="Create new"
          data-testid="sidebar-create-menu"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-foreground/10 text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-foreground/15 focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[popup-open]:bg-sidebar-foreground/15"
        >
          <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {!isGuest(user?.systemRole) && (
            <DropdownMenuItem onClick={() => setCreateChannelOpen(true)} data-testid="sidebar-menu-new-channel">
              <SquarePlus className="mr-2 h-4 w-4" aria-hidden="true" />
              New channel
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => go('/conversations/new')} data-testid="sidebar-menu-new-message">
            <MessageSquarePlus className="mr-2 h-4 w-4" aria-hidden="true" />
            New message
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setSidebarMode('home');
              requestAddCategory();
            }}
            data-testid="sidebar-create-category"
          >
            <FolderPlus className="mr-2 h-4 w-4" aria-hidden="true" />
            New category
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => go('/directory/channels')} data-testid="sidebar-browse-channels">
            <BookUser className="mr-2 h-4 w-4" aria-hidden="true" />
            Browse channels
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateChannelDialog open={createChannelOpen} onOpenChange={setCreateChannelOpen} />
    </div>
  );
});
