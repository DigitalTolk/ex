import { Bot, SlidersHorizontal } from 'lucide-react';

// The admin area: one "Admin" entry in the user menu, rendered by AdminLayout
// as tabs — the same shape the AI hub uses for Agents/Skills/Connectors.
// Shared here so the tab strip and any active-state check can never disagree
// about what belongs.
//
// `end` marks a tab whose path is a PREFIX of its siblings: /admin would stay
// highlighted on /admin/agents without exact matching.
export const ADMIN_TABS = [
  { to: '/admin', label: 'Workspace', Icon: SlidersHorizontal, end: true },
  { to: '/admin/agents', label: 'Agents', Icon: Bot, end: false },
] as const;

// ADMIN_HOME is where the user menu's Admin entry lands.
export const ADMIN_HOME = ADMIN_TABS[0].to;

// isAdminPath reports whether a pathname belongs to the admin area.
export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_HOME || pathname.startsWith(`${ADMIN_HOME}/`);
}
