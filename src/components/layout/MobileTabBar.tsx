import { useState, type ComponentType } from 'react';
import { Bell, Home, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useActivityUnread } from '@/hooks/useActivity';
import { setSidebarMode, useSidebarModeStore, type SidebarMode } from '@/stores/sidebar-mode';
import { AccountMenu } from './AccountMenu';
import { MOBILE_TAB_CLASS } from './mobile-tab';
import { MobileSearchSheet } from './MobileSearchSheet';

interface MobileTabBarProps {
  // Steps aside in a conversation and while the keyboard is up.
  hidden?: boolean;
}

// MobileTabBar is the phone's bottom navigation: Home, Activity, Search and
// You, where thumbs reach. It replaces the sidebar's Home / Activity switch and
// account footer on the mobile tier. It shows on the list screens; inside a
// conversation or thread the back button and composer take its place — so
// it only ever switches the list that is already showing.
export function MobileTabBar({ hidden = false }: MobileTabBarProps) {
  const mode = useSidebarModeStore((s) => s.mode);
  const unread = useActivityUnread();
  const [searchOpen, setSearchOpen] = useState(false);

  const choose = (next: SidebarMode) => setSidebarMode(next);

  return (
    <nav
      aria-label="Main"
      className={`shrink-0 border-t border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)] ${hidden ? 'hidden' : ''}`}
      data-testid="mobile-tab-bar"
    >
      <div className="flex h-15 items-stretch px-2 pt-3">
        <Tab label="Home" icon={Home} selected={mode === 'home'} onClick={() => choose('home')} testID="mobile-tab-home" />
        <Tab
          label="Activity"
          icon={Bell}
          selected={mode === 'activity'}
          onClick={() => choose('activity')}
          unread={unread}
          testID="mobile-tab-activity"
        />
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          className={`${MOBILE_TAB_CLASS} ${searchOpen ? 'text-sidebar-foreground' : 'text-muted-foreground'}`}
          data-testid="mobile-tab-search"
        >
          <Search className="h-6 w-6" aria-hidden="true" />
          <span>Search</span>
        </button>
        <AccountMenu variant="tab" />
      </div>
      <MobileSearchSheet open={searchOpen} onOpenChange={setSearchOpen} />
    </nav>
  );
}

interface TabProps {
  label: string;
  icon: ComponentType<{ className?: string }>;
  selected: boolean;
  onClick: () => void;
  unread?: number;
  testID: string;
}

function Tab({ label, icon: Icon, selected, onClick, unread = 0, testID }: TabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={unread > 0 ? `${label}, ${unread} unread` : label}
      className={`${MOBILE_TAB_CLASS} ${selected ? 'text-sidebar-foreground' : 'text-muted-foreground'}`}
      data-testid={testID}
    >
      <span className="relative inline-flex">
        <Icon className="h-6 w-6" aria-hidden="true" />
        {unread > 0 && (
          <Badge variant="brand" className="absolute -top-1 left-3.5 ring-2 ring-sidebar" data-testid="mobile-tab-unread">
            {unread > 99 ? '99+' : unread}
          </Badge>
        )}
      </span>
      <span aria-hidden="true">{label}</span>
    </button>
  );
}
