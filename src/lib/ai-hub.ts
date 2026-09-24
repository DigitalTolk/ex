import { Bot, Cable, Sparkles } from 'lucide-react';

// The AI hub: the three agent-feature pages the sidebar lists as ONE entry
// ("Agents") and AiHubLayout renders as tabs. Shared here so the sidebar's
// active state and the tab strip can never disagree about what belongs.
export const AI_HUB_TABS = [
  { to: '/agents', label: 'Agents', Icon: Bot },
  { to: '/skills', label: 'Skills', Icon: Sparkles },
  { to: '/connectors', label: 'Connectors', Icon: Cable },
] as const;

// AI_HUB_HOME is where the sidebar entry lands.
export const AI_HUB_HOME = AI_HUB_TABS[0].to;

// isAiHubPath reports whether a pathname belongs to the AI hub — the sidebar
// uses it to light its one entry for all three pages (and their sub-paths).
export function isAiHubPath(pathname: string): boolean {
  return AI_HUB_TABS.some((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
}
