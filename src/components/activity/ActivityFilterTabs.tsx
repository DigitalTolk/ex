import { useState, type ComponentType } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { AtSign, Inbox, MessageSquare, MessagesSquare, Smile } from 'lucide-react';
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
// reads as one line sliding across. On a phone the icons are larger and
// spread across the row, and the selected tab's label opens the same way.
export function ActivityFilterTabs({ filter, unread }: ActivityFilterTabsProps) {
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
        className="flex gap-2 border-b border-sidebar-border mobile:justify-between mobile:gap-0 mobile:px-2 mobile:overflow-x-auto mobile:[scrollbar-width:none] mobile:[&::-webkit-scrollbar]:hidden"
      >
        {ACTIVITY_TABS.map((t, i) => {
          const active = i === index;
          const expanded = active;
          // An opening tab's underline grows from the side the selection came
          // from; a closing one shrinks toward the new tab.
          const anchor = active ? (last.from < i ? 'left' : 'right') : index > i ? 'right' : 'left';
          const Icon = TAB_ICON[t.id];
          // Reactions never dot: they flash on the bell as they land. New
          // ones turn the Reactions tab bold and highlighted instead.
          const hasUnread = t.id !== 'all' && t.id !== 'reaction' && unread[t.id] > 0;
          const highlight = t.id === 'reaction' && unread[t.id] > 0;
          return (
            <Tabs.Tab
              key={t.id}
              value={t.id}
              aria-label={hasUnread ? `${t.label}, unread` : t.label}
              title={expanded ? undefined : t.label}
              className={`relative my-1 flex h-7 shrink-0 items-center rounded-md px-1.5 text-sm outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none mobile:my-0 mobile:h-12 mobile:px-2 ${
                highlight ? 'bg-sidebar-accent font-semibold' : 'font-medium'
              } ${active || highlight ? 'text-sidebar-foreground' : 'text-muted-foreground hover:text-sidebar-foreground'}`}
              data-testid={`activity-filter-${t.id}`}
              data-highlight={highlight ? 'true' : undefined}
            >
              <span className="relative shrink-0">
                <Icon className="h-4 w-4 mobile:h-5 mobile:w-5" aria-hidden="true" />
                {hasUnread && !highlight && (
                  <span
                    className="absolute -top-0.5 -right-1 h-1.5 w-1.5 rounded-full bg-brand ring-2 ring-sidebar"
                    aria-hidden="true"
                    data-testid={`activity-filter-${t.id}-dot`}
                  />
                )}
              </span>
              <span
                className={`grid transition-[grid-template-columns,margin-left,opacity] duration-300 ${EASE} motion-reduce:transition-none ${
                  expanded ? 'ml-1.5 grid-cols-[1fr] opacity-100 mobile:ml-2 mobile:text-base' : 'ml-0 grid-cols-[0fr] opacity-0'
                }`}
                aria-hidden="true"
              >
                <span className="overflow-hidden whitespace-nowrap">{t.label}</span>
              </span>
              <span
                className={`pointer-events-none absolute inset-x-1 -bottom-1.25 h-0.5 mobile:-bottom-px rounded-full bg-sidebar-foreground transition-transform duration-300 ${EASE} motion-reduce:transition-none ${
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
