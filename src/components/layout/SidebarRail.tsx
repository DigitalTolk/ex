import { memo, type ComponentType, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bell, BookUser, FilePenLine, MessagesSquare, Workflow } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useActivityUnread } from '@/hooks/useActivity';
import { useDrafts } from '@/hooks/useDrafts';
import { useUserState } from '@/hooks/useUserState';
import { AI_HUB_HOME, isAiHubPath } from '@/lib/ai-hub';
import { HOME_NAV_STATE } from '@/lib/home-nav';
import { GENERAL_CHANNEL_SLUG } from '@/lib/roles';
import { serverIconURL } from '@/lib/server-identity';
import { useReactionFlash } from '@/stores/reaction-flash';
import { setSidebarMode, useSidebarModeStore } from '@/stores/sidebar-mode';
import { useSidebarThemeClass } from '@/stores/sidebar-theme';
import { ActivityHoverPreview } from '@/components/activity/ActivityHoverPreview';
import { ReactionFlashIcon } from '@/components/activity/ReactionFlashIcon';
import { AccountMenu } from './AccountMenu';
import { DoNotDisturbButton } from './DoNotDisturbButton';

type RailPage = 'threads' | 'drafts' | 'agents' | 'directory';

// The page a path belongs to, when it is one the rail lists; a channel or a
// DM belongs to none. Activity is lit apart from the pages, for as long as
// the sidebar lists it: the rail always says what is on screen.
function railPage(pathname: string): RailPage | null {
  if (pathname === '/threads') return 'threads';
  if (pathname === '/drafts') return 'drafts';
  if (pathname === '/directory' || pathname.startsWith('/directory/')) return 'directory';
  if (isAiHubPath(pathname)) return 'agents';
  return null;
}

const count = (n: number) => (n > 99 ? '99+' : String(n));

// One stop on the rail: an icon tile with its name under it. The whole stop
// is the target; only the tile lights.
const ITEM_CLASS =
  'group/rail flex w-full flex-col items-center gap-1 rounded-lg py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring';
// The tile lifts a touch under the pointer and dips when pressed, with a
// little overshoot, and its icon plays a short motion of its own (the
// rail-* keyframes in index.css). All of it is off for reduced motion.
const tileClass = (active: boolean) =>
  `relative flex h-9 w-9 items-center justify-center rounded-lg transition-[background-color,color,transform] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover/rail:scale-110 group-active/rail:scale-95 motion-reduce:transform-none motion-reduce:transition-colors ${
    active
      ? 'bg-sidebar-foreground/15 text-sidebar-foreground'
      : 'text-muted-foreground group-hover/rail:bg-sidebar-foreground/10 group-hover/rail:text-sidebar-foreground'
  }`;
const labelClass = (active: boolean) =>
  `max-w-full text-center leading-[1.2] ${
    active ? 'font-semibold text-sidebar-foreground' : 'font-medium text-muted-foreground group-hover/rail:text-sidebar-foreground'
  }`;

// What each icon does while its stop is hovered.
const ICON_MOTION = {
  ring: 'origin-top group-hover/rail:animate-[rail-ring_0.7s_ease-in-out] motion-reduce:animate-none',
  write: 'group-hover/rail:animate-[rail-write_0.6s_ease-in-out] motion-reduce:animate-none',
  nod: 'group-hover/rail:animate-[rail-nod_0.5s_ease-in-out] motion-reduce:animate-none',
  twinkle: 'group-hover/rail:animate-[rail-twinkle_0.7s_ease-in-out] motion-reduce:animate-none',
  pop: 'group-hover/rail:animate-[rail-pop_0.5s_ease-in-out] motion-reduce:animate-none',
} as const;

function RailBadge({ value, testID }: { value: number; testID?: string }) {
  if (value <= 0) return null;
  return (
    <Badge variant="brand" className="absolute -top-1.5 -right-2" data-testid={testID}>
      {count(value)}
    </Badge>
  );
}

function RailLink({
  to,
  label,
  icon: Icon,
  active,
  badge = 0,
  badgeTestID,
  labelTestID,
  testID,
  onNavigate,
  motion,
  shown,
}: {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  motion: keyof typeof ICON_MOTION;
  // The label as drawn, when it breaks over two lines.
  shown?: ReactNode;
  active: boolean;
  badge?: number;
  badgeTestID?: string;
  labelTestID?: string;
  testID: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      aria-label={badge > 0 ? `${label}, ${badge} unread` : label}
      onClick={() => {
        // Going to a page leaves Activity: the sidebar lists the chats again.
        setSidebarMode('home');
        onNavigate?.();
      }}
      className={ITEM_CLASS}
      data-testid={testID}
    >
      <span className={tileClass(active)} data-rail-tile="true">
        <Icon className={`h-5 w-5 ${ICON_MOTION[motion]}`} aria-hidden="true" />
        <RailBadge value={badge} testID={badgeTestID} />
      </span>
      <span className={labelClass(active)} data-testid={labelTestID} aria-hidden="true">
        {shown ?? label}
      </span>
    </Link>
  );
}

// Activity swaps the sidebar's chat list for the Activity list, and back: it
// changes no page. (The Activity list's header has a way back too.)
function RailActivityButton({
  active,
  badge,
  children,
  buttonRef,
  onPointerEnter,
  onPointerLeave,
  onPreviewClose,
}: {
  active: boolean;
  badge: number;
  children: ReactNode;
  // The bell's hover preview anchors to the button.
  buttonRef: RefObject<HTMLButtonElement | null>;
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPreviewClose: () => void;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      aria-pressed={active}
      aria-label={badge > 0 ? `Activity, ${badge} unread` : 'Activity'}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={() => {
        onPreviewClose();
        setSidebarMode(active ? 'home' : 'activity');
      }}
      className={ITEM_CLASS}
      data-testid="sidebar-mode-activity"
    >
      <span className={tileClass(active)} data-rail-tile="true">
        {children}
        <RailBadge value={badge} testID="activity-unread-badge" />
      </span>
      <span className={labelClass(active)} aria-hidden="true">
        Activity
      </span>
    </button>
  );
}

// SidebarRail is the strip of icons at the window's left edge: the workspace
// mark, the places every screen can reach, and the account at its foot. The
// channel list sits beside it. Desktop and narrow-window layouts only; a
// phone has its tab bar.
export const SidebarRail = memo(function SidebarRail({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const mode = useSidebarModeStore((s) => s.mode);
  const activityUnread = useActivityUnread();
  // One marker per thread with unread replies.
  const unreadThreads = useUserState().data?.threadNotifications?.length ?? 0;
  const draftCount = useDrafts().data?.length ?? 0;
  // The Activity bell becomes the emoji for a moment when a reaction lands.
  const flash = useReactionFlash();
  const themeClass = useSidebarThemeClass();
  const page = railPage(pathname);

  return (
    <nav
      aria-label="Main"
      // A light rail and a light list need a line between them; dark ones
      // are told apart by their tone alone.
      className={`${themeClass || 'border-r border-sidebar-border'} flex w-[4.5rem] shrink-0 flex-col items-center bg-sidebar-rail px-1 text-sidebar-foreground`}
      data-app-chrome="true"
      data-sidebar-rail="true"
      data-testid="sidebar-rail"
    >
      {/* Level with the top bar; the window drags by it, and macOS traffic
          lights sit over it in the desktop app (index.css pushes the mark
          below them there). */}
      <div
        className="flex h-12 w-full shrink-0 items-center justify-center [-webkit-app-region:drag]"
        data-rail-mark="true"
      >
        {/* The mark is the way home: ~general, with the channel list in the
            sidebar and no panel open. Not draggable, or the desktop app
            would swallow the click. */}
        <Link
          to={`/channel/${GENERAL_CHANNEL_SLUG}`}
          state={HOME_NAV_STATE}
          onClick={() => {
            setSidebarMode('home');
            onNavigate?.();
          }}
          aria-label={`Go to ~${GENERAL_CHANNEL_SLUG}`}
          className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring [-webkit-app-region:no-drag]"
          data-testid="sidebar-rail-home"
        >
          <img src={serverIconURL()} alt="" width={32} height={32} className="h-8 w-8 rounded-lg" data-testid="sidebar-rail-logo" />
        </Link>
      </div>
      {/* Padding, not a margin, above the first stop: a scrolling box cuts
          off what leaves it, and the first stop's badge rises past its tile. */}
      <div className="flex w-full min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto pt-2">
        <RailLink
          to="/threads"
          label="Threads"
          icon={MessagesSquare}
          motion="pop"
          active={page === 'threads'}
          badge={unreadThreads}
          badgeTestID="threads-unread-badge"
          labelTestID="threads-nav-label"
          testID="sidebar-rail-threads"
          onNavigate={onNavigate}
        />
        <ActivityHoverPreview>
          {(trigger) => (
            <RailActivityButton
              active={mode === 'activity'}
              badge={activityUnread}
              buttonRef={trigger.ref}
              onPointerEnter={trigger.onPointerEnter}
              onPointerLeave={trigger.onPointerLeave}
              onPreviewClose={trigger.onClick}
            >
              {flash ? (
                <ReactionFlashIcon flash={flash} className="h-5 w-5" />
              ) : (
                <Bell className={`h-5 w-5 ${ICON_MOTION.ring}`} aria-hidden="true" />
              )}
            </RailActivityButton>
          )}
        </ActivityHoverPreview>
        <RailLink
          to="/drafts"
          label="Drafts"
          icon={FilePenLine}
          motion="write"
          active={page === 'drafts'}
          badge={draftCount}
          testID="sidebar-rail-drafts"
          onNavigate={onNavigate}
        />
        <RailLink
          to="/directory/channels"
          label="Directory"
          icon={BookUser}
          motion="nod"
          active={page === 'directory'}
          testID="sidebar-rail-directory"
          onNavigate={onNavigate}
        />
        {/* The AI hub comes last, after the chat's own places. */}
        <RailLink
          to={AI_HUB_HOME}
          label="Agents and tools"
          shown={
            <>
              Agents
              <br />
              &amp; tools
            </>
          }
          icon={Workflow}
          motion="twinkle"
          active={page === 'agents'}
          testID="sidebar-rail-agents"
          onNavigate={onNavigate}
        />
      </div>
      {/* Do Not Disturb, right above the account. */}
      <div className="flex shrink-0 justify-center pt-2">
        <DoNotDisturbButton />
      </div>
      <AccountMenu variant="rail" />
    </nav>
  );
});
