import type { ReactNode } from 'react';

// The focus ring is drawn inside the link: the row clips its paint to its own
// box (see ChannelRow), and the usual ring sits outside it.
const BASE_CLASS =
  'relative flex flex-1 min-w-0 items-center gap-2 rounded-md py-1.5 pl-2 pr-12 text-sm transition-colors focus-visible:-outline-offset-2 touch:pr-16 mobile:h-12 mobile:py-0 mobile:pl-3 mobile:pr-20 mobile:text-base';
const ACTIVE_CLASS =
  'bg-sidebar-accent text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]';
const UNREAD_CLASS = 'font-bold text-white hover:bg-white/10';
const READ_CLASS = 'text-gray-300 hover:bg-white/10 hover:text-white';

// SidebarRowLink is the link that fills a sidebar row. It is a plain anchor,
// not a react-router Link: a Link reads the location, so every row's link
// re-rendered on every channel switch, thousands of them for an imported
// account. The sidebar decides which row is active and passes the navigation
// down.
export function SidebarRowLink({
  to,
  active,
  hasUnread,
  onNavigate,
  onClose,
  suppressNavClick,
  suppressNavigation,
  onSuppressNavigationConsumed,
  children,
}: {
  to: string;
  active: boolean;
  hasUnread: boolean;
  onNavigate: (to: string) => void;
  onClose: () => void;
  // One-shot: true when a touch long-press just opened the row menu.
  suppressNavClick: () => boolean;
  suppressNavigation?: boolean;
  onSuppressNavigationConsumed?: () => void;
  children: ReactNode;
}) {
  return (
    <a
      href={to}
      aria-current={active ? 'page' : undefined}
      draggable={false}
      className={`${BASE_CLASS} ${active ? ACTIVE_CLASS : hasUnread ? UNREAD_CLASS : READ_CLASS}`}
      onClick={(event) => {
        // A touch long-press that opened the menu also fires a click on
        // release; swallow it so the row doesn't navigate.
        if (suppressNavClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (suppressNavigation) {
          event.preventDefault();
          event.stopPropagation();
          onSuppressNavigationConsumed?.();
          return;
        }
        onClose();
        // A modified click opens a new tab or window, as on any link.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        onNavigate(to);
      }}
    >
      {children}
    </a>
  );
}
