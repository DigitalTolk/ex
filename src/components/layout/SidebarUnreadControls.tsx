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
// "+ Add category" row; its menu holds the two unread view options. While an
// option is on, the icon turns brand pink on a soft pink pill and its tooltip
// names what is on: clearly highlighted, but a setting, not an alert. A red
// dot used to mark it, and red reads as "something needs you".
export function SidebarUnreadControls({
  unreadOnly,
  onUnreadOnlyChange,
  unreadSection,
  onUnreadSectionChange,
}: SidebarUnreadControlsProps) {
  const active = unreadOnly || unreadSection;
  const label = active
    ? `Unread view: ${[unreadOnly && 'unread only', unreadSection && 'grouped at top'].filter(Boolean).join(', ')}`
    : 'Unread view options';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        data-testid="sidebar-unread-options"
        data-active={active ? 'true' : 'false'}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors touch:h-8 touch:w-8 mobile:h-10 mobile:w-10 ${
          active
            ? 'bg-brand/15 text-brand hover:bg-brand/25'
            : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'
        }`}
      >
        <ListFilter className="h-3.5 w-3.5 mobile:h-4 mobile:w-4" aria-hidden="true" />
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
