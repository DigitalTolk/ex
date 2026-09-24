import { NavLink, Outlet } from 'react-router-dom';
import { AI_HUB_TABS } from '@/lib/ai-hub';

// AiHubLayout is the pathless layout route behind the sidebar's single
// "Agents" entry: a tab strip for the three agent-feature pages (Agents, Skills,
// Connectors) above whichever page the URL names. The pages themselves and
// their routes are untouched, so /skills and /connectors deep links, the
// permalinks in chat and the connector callback flows all keep working — the
// sidebar just stops listing them one by one.
export default function AiHubLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-hub">
      <nav
        aria-label="AI sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 pt-2 sm:px-6"
      >
        {AI_HUB_TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
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
