import { useState, type ComponentType } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { AtSign, Inbox, MessageSquare, MessagesSquare, Smile } from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ACTIVITY_TABS, type ActivityTab } from '@/lib/activity-feed';
import { setActivityFilter } from '@/stores/sidebar-mode';

const TAB_ICON: Record<ActivityTab, ComponentType<{ className?: string }>> = {
  all: Inbox,
  dm: MessageSquare,
  mention: AtSign,
  thread_reply: MessagesSquare,
  reaction: Smile,
};

const EASE = 'ease-[cubic-bezier(0.4,0,0.2,1)]';

interface ActivityFilterTabsProps {
  filter: ActivityTab;
  // Unread count per tab, for the dots.
  unread: Record<ActivityTab, number>;
}

// The filter tabs (arrow keys move between them). Only the selected tab shows
// its label; the others are just their icon. Switching animates both ends at
// once: the old label closes while the new one opens, so the new tab grows
// into the space the old one gives up. The underline does the same — it
// retracts toward the new tab and grows in from the old one's side — so it
// reads as one line sliding across. On a phone every tab keeps its label.
export function ActivityFilterTabs({ filter, unread }: ActivityFilterTabsProps) {
  const isMobile = useIsMobile();
  const index = ACTIVITY_TABS.findIndex((t) => t.id === filter);
  // Where the selection came from, so each tab knows which side to animate
  // from. Set during render so the render that changes the filter already
  // sees the previous one.
  const [last, setLast] = useState({ filter, from: index });
  if (last.filter !== filter) setLast({ filter, from: ACTIVITY_TABS.findIndex((t) => t.id === last.filter) });

  return (
    <Tabs.Root value={filter} onValueChange={(value) => setActivityFilter(value as ActivityTab)}>
      <Tabs.List
        aria-label="Activity filters"
        activateOnFocus
        className="flex gap-2 border-b border-sidebar-border mobile:justify-between mobile:gap-0 mobile:overflow-x-auto mobile:[scrollbar-width:none] mobile:[&::-webkit-scrollbar]:hidden"
      >
        {ACTIVITY_TABS.map((t, i) => {
          const active = i === index;
          const expanded = active || isMobile;
          // An opening tab's underline grows from the side the selection came
          // from; a closing one shrinks toward the new tab.
          const anchor = active ? (last.from < i ? 'left' : 'right') : index > i ? 'right' : 'left';
          const Icon = TAB_ICON[t.id];
          const hasUnread = t.id !== 'all' && unread[t.id] > 0;
          return (
            <Tabs.Tab
              key={t.id}
              value={t.id}
              aria-label={hasUnread ? `${t.label}, unread` : t.label}
              title={expanded ? undefined : t.label}
              className={`relative flex h-9 shrink-0 items-center px-1.5 text-sm font-medium outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none mobile:h-11 mobile:px-1 ${
                active ? 'text-sidebar-foreground' : 'text-muted-foreground hover:text-sidebar-foreground'
              }`}
              data-testid={`activity-filter-${t.id}`}
            >
              <span className="relative shrink-0">
                <Icon className="h-4 w-4" aria-hidden="true" />
                {hasUnread && (
                  <span
                    className="absolute -top-0.5 -right-1 h-1.5 w-1.5 rounded-full bg-brand ring-2 ring-sidebar"
                    aria-hidden="true"
                    data-testid={`activity-filter-${t.id}-dot`}
                  />
                )}
              </span>
              <span
                className={`grid transition-[grid-template-columns,margin-left,opacity] duration-300 ${EASE} motion-reduce:transition-none ${
                  expanded ? 'ml-1.5 grid-cols-[1fr] opacity-100 mobile:ml-1' : 'ml-0 grid-cols-[0fr] opacity-0'
                }`}
                aria-hidden="true"
              >
                <span className="overflow-hidden whitespace-nowrap">{t.label}</span>
              </span>
              <span
                className={`pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-sidebar-foreground transition-transform duration-300 ${EASE} motion-reduce:transition-none ${
                  active ? 'scale-x-100' : 'scale-x-0'
                } ${anchor === 'left' ? 'origin-left' : 'origin-right'}`}
                aria-hidden="true"
              />
            </Tabs.Tab>
          );
        })}
      </Tabs.List>
    </Tabs.Root>
  );
}
