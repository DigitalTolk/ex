import type { ComponentType } from 'react';
import { Bell, Home } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useActivity } from '@/hooks/useActivity';
import { setSidebarMode, useSidebarModeStore, type SidebarMode } from '@/stores/sidebar-mode';

// ActivityModeSwitch is the Home / Activity toggle at the top of the sidebar.
// It swaps what the sidebar lists; it doesn't change the page, except that
// leaving Activity from the Activity page goes home (that page is only the
// empty "pick something" pane).
//
// The selected side grows to show its label; the other shrinks to its icon,
// so the pill keeps plenty of space. The unread count rides on Activity —
// beside the label when selected, as a small badge on the bell when not.
export function ActivityModeSwitch() {
  const mode = useSidebarModeStore((s) => s.mode);
  const { data: feed } = useActivity();
  const unread = feed?.unread ?? 0;
  const navigate = useNavigate();
  const location = useLocation();

  const choose = (next: SidebarMode) => {
    setSidebarMode(next);
    if (next === 'home' && location.pathname === '/activity') navigate('/');
  };

  return (
    <div
      role="tablist"
      aria-label="Sidebar"
      className="flex w-full gap-1 rounded-lg bg-black/[0.03] p-[3px] dark:bg-white/[0.03]"
      data-testid="sidebar-mode-switch"
    >
      <ModeTab mode="home" label="Home" icon={Home} selected={mode === 'home'} onSelect={choose} />
      <ModeTab mode="activity" label="Activity" icon={Bell} selected={mode === 'activity'} onSelect={choose} unread={unread} />
    </div>
  );
}

interface ModeTabProps {
  mode: SidebarMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
  selected: boolean;
  onSelect: (mode: SidebarMode) => void;
  unread?: number;
}

function ModeTab({ mode, label, icon: Icon, selected, onSelect, unread = 0 }: ModeTabProps) {
  const count = unread > 99 ? '99+' : String(unread);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={unread > 0 ? `${label}, ${unread} unread` : label}
      title={selected ? undefined : label}
      onClick={() => onSelect(mode)}
      // flex-grow animates: the selected tab widens (from the left) to fit its label while
      // the other settles to an icon-sized pill.
      style={{ flexGrow: selected ? 1 : 0 }}
      className={`relative flex h-8 min-w-0 basis-9 items-center justify-start overflow-hidden rounded-md px-2.5 text-sm font-medium outline-none transition-[flex-grow,background-color,color,box-shadow] duration-300 ease-out focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none ${
        selected
          ? 'bg-background text-sidebar-foreground shadow-xs dark:bg-sidebar-accent'
          : 'text-muted-foreground/70 hover:bg-black/[0.03] hover:text-muted-foreground dark:hover:bg-white/[0.04]'
      }`}
      data-testid={`sidebar-mode-${mode}`}
    >
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {!selected && unread > 0 && (
          <span
            className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand-strong px-[3px] text-[9px] leading-none font-bold text-brand-foreground"
            data-testid="activity-unread-badge"
          >
            {count}
          </span>
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
        <span
          className="ml-2 flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-brand-strong px-1 text-[11px] leading-none font-bold text-brand-foreground"
          data-testid="activity-unread-badge"
        >
          {count}
        </span>
      )}
    </button>
  );
}
