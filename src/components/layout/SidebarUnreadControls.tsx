import { Check, ListFilter } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SidebarUnreadControlsProps {
  unreadOnly: boolean;
  onUnreadOnlyChange: (on: boolean) => void;
  unreadSection: boolean;
  onUnreadSectionChange: (on: boolean) => void;
}

// SidebarUnreadControls is one small filter icon at the end of the
// "+ Add category" row; its menu holds the two unread view options. A dot
// on the icon shows an option is on.
export function SidebarUnreadControls({
  unreadOnly,
  onUnreadOnlyChange,
  unreadSection,
  onUnreadSectionChange,
}: SidebarUnreadControlsProps) {
  const active = unreadOnly || unreadSection;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Unread view options"
        title="Unread view options"
        data-testid="sidebar-unread-options"
        className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-white/5 hover:text-gray-300 touch:h-8 touch:w-8 mobile:h-10 mobile:w-10 ${
          active ? 'text-white' : 'text-gray-500'
        }`}
      >
        <ListFilter className="h-3.5 w-3.5 mobile:h-4 mobile:w-4" aria-hidden="true" />
        {active && (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => onUnreadOnlyChange(!unreadOnly)} data-testid="sidebar-unread-filter">
          <Check className={`mr-2 h-4 w-4 ${unreadOnly ? '' : 'invisible'}`} aria-hidden="true" />
          Show unread only
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onUnreadSectionChange(!unreadSection)}
          data-testid="sidebar-unread-section-toggle"
        >
          <Check className={`mr-2 h-4 w-4 ${unreadSection ? '' : 'invisible'}`} aria-hidden="true" />
          Group unread at top
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
