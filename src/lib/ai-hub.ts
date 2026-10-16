import { Bot, Cable, CalendarClock, FolderKanban, MonitorCog, Sparkles, type LucideIcon } from 'lucide-react';

// The AI hub: the agent-feature pages the sidebar lists as ONE entry
// ("Agents") and AiHubLayout renders as tabs. Shared here so the sidebar's
// active state and the tab strip can never disagree about what belongs.
export interface AiHubTab {
  to: string;
  label: string;
  Icon: LucideIcon;
  // Shown only while the workspace's "Runners in the app" switch is on.
  needsRunnersInApp?: boolean;
}

export const AI_HUB_TABS: readonly AiHubTab[] = [
  { to: '/agents', label: 'Agents', Icon: Bot },
  { to: '/skills', label: 'Skills', Icon: Sparkles },
  { to: '/schedules', label: 'Schedules', Icon: CalendarClock },
  { to: '/connectors', label: 'Connectors', Icon: Cable },
  { to: '/projects', label: 'Projects', Icon: FolderKanban },
  { to: '/runners', label: 'Runners', Icon: MonitorCog, needsRunnersInApp: true },
];

// AI_HUB_HOME is where the sidebar entry lands.
export const AI_HUB_HOME = AI_HUB_TABS[0].to;

// visibleAiHubTabs drops the tabs whose workspace switch is off.
export function visibleAiHubTabs(runnersInApp: boolean): readonly AiHubTab[] {
  return AI_HUB_TABS.filter((t) => !t.needsRunnersInApp || runnersInApp);
}

// isAiHubPath reports whether a pathname belongs to the AI hub — the sidebar
// uses it to light its one entry for all of its pages (and their sub-paths).
export function isAiHubPath(pathname: string): boolean {
  return AI_HUB_TABS.some((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
}
