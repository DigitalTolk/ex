import type { ComponentType } from 'react';
import { Bell, Home } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useActivityUnread } from '@/hooks/useActivity';
import { setSidebarMode, useSidebarModeStore, type SidebarMode } from '@/stores/sidebar-mode';

// ActivityModeSwitch is the Home / Activity toggle at the top of the sidebar.
// It swaps what the sidebar lists; it doesn't change the page.
//
// The selected side grows to show its label; the other shrinks to its icon,
// so the pill keeps plenty of space. The unread count rides on Activity —
// beside the label when selected, on the bell when not.
export function ActivityModeSwitch() {
  const mode = useSidebarModeStore((s) => s.mode);
  const unread = useActivityUnread();
  return (
    <div role="group" aria-label="Sidebar" className="flex w-full gap-1 rounded-lg bg-sidebar-accent/60 p-1" data-testid="sidebar-mode-switch">
      <ModeButton mode="home" label="Home" icon={Home} selected={mode === 'home'} />
      <ModeButton mode="activity" label="Activity" icon={Bell} selected={mode === 'activity'} unread={unread} />
    </div>
  );
}

interface ModeButtonProps {
  mode: SidebarMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
  selected: boolean;
  unread?: number;
}

function ModeButton({ mode, label, icon: Icon, selected, unread = 0 }: ModeButtonProps) {
  const count = unread > 99 ? '99+' : String(unread);
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={unread > 0 ? `${label}, ${unread} unread` : label}
      title={selected ? undefined : label}
      onClick={() => setSidebarMode(mode)}
      // flex-grow animates: the selected button widens to fit its label while
      // the other settles to an icon-sized pill.
      style={{ flexGrow: selected ? 1 : 0 }}
      className={`relative flex h-8 min-w-0 basis-9 items-center justify-start overflow-hidden rounded-md px-2.5 text-sm font-medium outline-none transition-[flex-grow,background-color,color,box-shadow] duration-300 ease-out focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none ${
        selected
          ? 'bg-background text-sidebar-foreground shadow-xs dark:bg-sidebar-accent'
          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
      }`}
      data-testid={`sidebar-mode-${mode}`}
    >
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {!selected && unread > 0 && (
          <Badge variant="brand" className="absolute -top-2 -right-3" data-testid="activity-unread-badge">
            {count}
          </Badge>
        )}
      </span>
      <span
        className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-300 ease-out motion-reduce:transition-none ${
          selected ? 'ml-2 max-w-24 opacity-100' : 'ml-0 max-w-0 opacity-0'
        }`}
        aria-hidden="true"
      >
        {label}
      </span>
      {selected && unread > 0 && (
        <Badge variant="brand" className="ml-2" data-testid="activity-unread-badge">
          {count}
        </Badge>
      )}
    </button>
  );
}
