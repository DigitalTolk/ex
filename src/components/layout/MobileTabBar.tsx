import { useState, type ComponentType } from 'react';
import { Bell, Home, Search } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useActivity } from '@/hooks/useActivity';
import { setSidebarMode, useSidebarModeStore, type SidebarMode } from '@/stores/sidebar-mode';
import { AccountMenu } from './AccountMenu';
import { MOBILE_TAB_CLASS } from './mobile-tab';
import { MobileSearchSheet } from './MobileSearchSheet';

interface MobileTabBarProps {
  // Brings the list (the channel drawer) into view when a conversation is
  // open, so Home and Activity always land on their list.
  onShowList: () => void;
  // Steps aside in a conversation and while the keyboard is up.
  hidden?: boolean;
}

// MobileTabBar is the phone's bottom navigation: Home, Activity, Search and
// You, where thumbs reach. It replaces the sidebar's Home / Activity switch and
// account footer on the mobile tier. It shows on the list screens; inside a
// conversation or thread the back button and composer take its place.
export function MobileTabBar({ onShowList, hidden = false }: MobileTabBarProps) {
  const mode = useSidebarModeStore((s) => s.mode);
  const { data: feed } = useActivity();
  const unread = feed?.unread ?? 0;
  const navigate = useNavigate();
  const location = useLocation();

  const choose = (next: SidebarMode) => {
    setSidebarMode(next);
    if (location.pathname === '/activity') navigate('/');
    else onShowList();
  };

  // Search opens a sheet with recent searches over the current screen.
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <nav
      aria-label="Main"
      className={`shrink-0 border-t border-sidebar-border bg-sidebar pb-[env(safe-area-inset-bottom)] ${hidden ? 'hidden' : ''}`}
      data-testid="mobile-tab-bar"
    >
      <div className="flex h-[3.75rem] items-stretch px-2 pt-3">
        <Tab label="Home" icon={Home} selected={mode === 'home'} onClick={() => choose('home')} testID="mobile-tab-home" />
        <Tab
          label="Activity"
          icon={Bell}
          selected={mode === 'activity'}
          onClick={() => choose('activity')}
          unread={unread}
          testID="mobile-tab-activity"
        />
        <Tab label="Search" icon={Search} selected={searchOpen} onClick={() => setSearchOpen(true)} testID="mobile-tab-search" />
        <AccountMenu variant="tab" />
      </div>
      {searchOpen && <MobileSearchSheet onClose={() => setSearchOpen(false)} />}
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
      aria-current={selected ? 'page' : undefined}
      aria-label={unread > 0 ? `${label}, ${unread} unread` : label}
      className={`${MOBILE_TAB_CLASS} ${selected ? 'text-sidebar-foreground' : 'text-muted-foreground'}`}
      data-testid={testID}
    >
      <span className="relative inline-flex">
        <Icon className="h-6 w-6" aria-hidden="true" />
        {unread > 0 && (
          <span
            className="absolute -top-1 left-3.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-strong px-1 text-[11px] leading-none font-bold text-brand-foreground ring-2 ring-sidebar"
            data-testid="mobile-tab-unread"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </span>
      <span aria-hidden="true">{label}</span>
    </button>
  );
}
