import { NavLink, Outlet } from 'react-router-dom';
import { ADMIN_TABS } from '@/lib/admin-tabs';
import { useAuth } from '@/context/AuthContext';
import { isAdmin } from '@/lib/roles';

// AdminLayout is the layout route behind the user menu's single "Admin" entry:
// a tab strip over the admin pages, mirroring AiHubLayout. Each page keeps its
// own URL so /admin and /admin/agents are both deep-linkable.
//
// The guard is here as well as on each page: without it the tab strip would
// render for a non-admin who typed the URL, advertising pages they cannot
// open. Every route behind these tabs is admin-gated server-side too — this is
// navigation, not security.
export default function AdminLayout() {
  const { user } = useAuth();

  if (!isAdmin(user?.systemRole)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p className="text-sm text-muted-foreground">Admin access required.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="admin-hub">
      <nav
        aria-label="Admin sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 pt-2 sm:px-6"
      >
        {ADMIN_TABS.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'border-primary font-semibold text-foreground'
                  : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
              }`
            }
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
