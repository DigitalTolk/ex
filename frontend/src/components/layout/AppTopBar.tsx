import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Menu,
  Settings,
  LogOut,
  User as UserIcon,
  CalendarClock,
  Info,
  UserPlus,
  Smile,
  ServerCog,
  Webhook,
  Bell,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SearchBar } from '@/components/SearchBar';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { isAdmin, isGuest } from '@/lib/roles';
import { getCapacitorPlugin, isNativePlatform } from '@/lib/capacitor';
import { EditProfileDialog } from '@/components/EditProfileDialog';
import { NotificationSettingsDialog } from '@/components/NotificationSettingsDialog';
import { UserStatusDialog } from '@/components/UserStatusDialog';
import { AboutDialog } from '@/components/AboutDialog';
import { InviteDialog } from '@/components/InviteDialog';

interface AppTopBarProps {
  onOpenChannels?: () => void;
  channelsButtonHidden?: boolean;
}

/**
 * Slim app-wide top bar — global SearchBar centred with the single
 * account-avatar dropdown on the right. The dropdown hosts every
 * user-facing action that previously lived in the sidebar's user
 * menu: profile/status, invites, custom emojis, admin, change server,
 * about, theme switch, and sign-out. The mobile menu button (left)
 * opens the channels drawer; it stays in the AppLayout's swipe
 * handler hierarchy.
 */
interface MenuAction {
  key: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  testID?: string;
  separatorBefore?: boolean;
}

export function AppTopBar({ onOpenChannels, channelsButtonHidden }: AppTopBarProps) {
  const { user, logout } = useAuth();
  const { online } = usePresence();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [changeServerOpen, setChangeServerOpen] = useState(false);
  // Mobile account-menu sheet — full-screen Dialog opened on tap of
  // the avatar. The same set of actions on desktop renders inside a
  // small DropdownMenu, which would otherwise be hard to hit and
  // visually cramped on a phone.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const initials = user?.displayName
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) ?? '??';

  const userOnline = user?.id ? online.has(user.id) : false;

  const nativePlugin = getCapacitorPlugin('ServerNavigation');
  const serverNavigation = isNativePlatform() && nativePlugin?.resetServer ? nativePlugin : null;

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  // Shared action list — used by both the desktop DropdownMenu and
  // the mobile full-screen sheet. Single source of truth keeps the
  // two surfaces from drifting.
  const menuActions: MenuAction[] = [
    {
      key: 'profile',
      icon: <UserIcon className="h-4 w-4" />,
      label: 'Edit profile',
      onSelect: () => setProfileOpen(true),
    },
    {
      key: 'status',
      icon: <CalendarClock className="h-4 w-4" />,
      label: 'Set status',
      onSelect: () => setStatusOpen(true),
    },
    {
      key: 'notifications',
      icon: <Bell className="h-4 w-4" />,
      label: 'Notification settings',
      onSelect: () => setNotificationsOpen(true),
      testID: 'user-menu-notifications',
    },
    ...(isAdmin(user?.systemRole)
      ? [
          {
            key: 'invite',
            icon: <UserPlus className="h-4 w-4" />,
            label: 'Invite people',
            onSelect: () => setInviteOpen(true),
            testID: 'user-menu-invite',
          } satisfies MenuAction,
        ]
      : []),
    ...(!isGuest(user?.systemRole)
      ? [
          {
            key: 'emojis',
            icon: <Smile className="h-4 w-4" />,
            label: 'Custom emojis',
            onSelect: () => navigate('/emojis'),
            testID: 'user-menu-emojis',
          } satisfies MenuAction,
        ]
      : []),
    ...(isAdmin(user?.systemRole)
      ? [
          {
            key: 'webhooks',
            icon: <Webhook className="h-4 w-4" />,
            label: 'Incoming webhooks',
            onSelect: () => navigate('/webhooks'),
            testID: 'user-menu-webhooks',
          } satisfies MenuAction,
          {
            key: 'admin',
            icon: <Settings className="h-4 w-4" />,
            label: 'Admin',
            onSelect: () => navigate('/admin'),
            testID: 'user-menu-admin',
          } satisfies MenuAction,
        ]
      : []),
    ...(serverNavigation
      ? [
          {
            key: 'change-server',
            icon: <ServerCog className="h-4 w-4" />,
            label: 'Change server',
            onSelect: () => setChangeServerOpen(true),
            testID: 'user-menu-change-server',
          } satisfies MenuAction,
        ]
      : []),
    {
      key: 'about',
      icon: <Info className="h-4 w-4" />,
      label: 'About Server',
      onSelect: () => setAboutOpen(true),
      testID: 'user-menu-about',
      separatorBefore: true,
    },
    {
      key: 'signout',
      icon: <LogOut className="h-4 w-4" />,
      label: 'Sign out',
      onSelect: handleLogout,
      testID: 'user-menu-signout',
      separatorBefore: true,
    },
  ];

  function runActionAndCloseSheet(action: MenuAction) {
    // Run the action (navigate / open the next dialog) BEFORE closing this
    // sheet. Closing first lets the full-screen Dialog's focus-trap + scroll
    // lock teardown run ahead of the navigation, which on mobile webviews
    // could swallow it — tapping "Admin"/"Incoming webhooks" then appeared to
    // do nothing. Committing the navigation first avoids that race.
    action.onSelect();
    setMobileMenuOpen(false);
  }

  return (
    <>
      <header
        // Compact macOS title-bar strip on desktop (36px tall, minimal
        // horizontal padding). On mobile the touch targets and the
        // 36px search field need breathing room, so the strip grows
        // to 48px and gains a hair more horizontal padding — without
        // it the search input clips against the bottom border. The
        // strip is draggable-as-a-titlebar on native via Capacitor
        // (carve-outs cover the interactive children).
        // Equal 1fr side columns keep the search field centred in the
        // viewport regardless of how wide the left (channels) or right
        // (account) controls are.
        className="grid h-12 max-md:h-14 w-full shrink-0 grid-cols-[1fr_minmax(0,36rem)_1fr] items-center gap-2 border-b border-border bg-sidebar px-2 max-md:px-3 text-sidebar-foreground [-webkit-app-region:drag] [&_button,&_a,&_input]:[-webkit-app-region:no-drag]"
        data-testid="app-shell-header"
        data-app-chrome="true"
        // The global search field lives on this sidebar-coloured strip, so the
        // mobile keyboard background must match the sidebar, not the chat.
        data-keyboard-surface="sidebar"
      >
        <div className="flex items-center">
          {/* The hamburger shows whenever the channel sidebar isn't already
              open (mobile drawer closed, or tablet md–lg which has no
              permanent sidebar). When it should be hidden — drawer open, or
              the home/start page where the channel list is the main view —
              we keep it mounted but `invisible` so the column's box never
              changes width and the centred search bar can't shift/resize.
              It's dropped only on desktop (lg+) where the sidebar is
              permanent. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenChannels}
            aria-label="Open channels"
            aria-hidden={channelsButtonHidden || undefined}
            tabIndex={channelsButtonHidden ? -1 : 0}
            className={`h-7 w-7 text-sidebar-foreground hover:bg-sidebar-accent lg:hidden ${
              channelsButtonHidden ? 'invisible' : ''
            }`}
          >
            <Menu className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-w-0 w-full">
          <SearchBar />
        </div>

        <div className="flex items-center justify-end md:pr-2">
          {isMobile ? (
            // Mobile: tapping the avatar opens a full-screen sheet
            // dialog rather than a cramped dropdown — easier to hit
            // and gives every menu entry full-width touch surface.
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Account menu"
              data-testid="topbar-account"
              className="relative inline-flex h-10 w-10 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Avatar className="size-8">
                <AvatarImage src={user?.avatarURL} alt="" />
                <AvatarFallback className="bg-muted text-foreground text-xs">{initials}</AvatarFallback>
              </Avatar>
              <span
                aria-hidden
                className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar ${userOnline ? 'bg-online' : 'bg-muted-foreground'}`}
              />
            </button>
          ) : (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                className="relative inline-flex h-10 w-10 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                aria-label="Account menu"
                data-testid="topbar-account"
              >
                <Avatar className="size-8">
                  <AvatarImage src={user?.avatarURL} alt="" />
                  <AvatarFallback className="bg-muted text-foreground text-xs">{initials}</AvatarFallback>
                </Avatar>
                <span
                  aria-hidden
                  className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar ${userOnline ? 'bg-online' : 'bg-muted-foreground'}`}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {menuActions.map((action, idx) => {
                  const separator = action.separatorBefore && idx > 0 ? (
                    <DropdownMenuSeparator key={`sep-${action.key}`} />
                  ) : null;
                  return (
                    <span key={action.key}>
                      {separator}
                      <DropdownMenuItem onClick={action.onSelect} data-testid={action.testID}>
                        <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">{action.icon}</span>
                        {action.label}
                      </DropdownMenuItem>
                    </span>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {/* Mobile-only full-screen account sheet. The Dialog component
          already collapses to inset-0 on max-md so we just plug a
          tall vertical list inside. Keeping the desktop dropdown
          above + this sheet below means no behaviour duplication —
          both surfaces dispatch the same `menuActions` list. */}
      <Dialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <DialogContent className="md:hidden" mobileCloseLabel="Close" data-testid="mobile-account-sheet">
          <DialogHeader>
            <DialogTitle>Account</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
            <Avatar className="h-10 w-10">
              <AvatarImage src={user?.avatarURL} alt="" />
              <AvatarFallback className="bg-muted text-foreground text-sm">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{user?.displayName}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
            </div>
          </div>
          <nav className="flex flex-col gap-1" aria-label="Account menu">
            {menuActions.map((action, idx) => (
              <span key={action.key}>
                {action.separatorBefore && idx > 0 ? (
                  <div className="my-1 h-px bg-border" role="separator" />
                ) : null}
                <button
                  type="button"
                  onClick={() => runActionAndCloseSheet(action)}
                  data-testid={action.testID}
                  className="flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-base hover:bg-muted active:bg-muted"
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground">
                    {action.icon}
                  </span>
                  {action.label}
                </button>
              </span>
            ))}
          </nav>
        </DialogContent>
      </Dialog>

      <EditProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
      <NotificationSettingsDialog open={notificationsOpen} onOpenChange={setNotificationsOpen} />
      <UserStatusDialog
        key={`${user?.id ?? ''}:${user?.userStatus?.emoji ?? ''}:${user?.userStatus?.text ?? ''}:${user?.userStatus?.clearAt ?? ''}`}
        open={statusOpen}
        onOpenChange={setStatusOpen}
      />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <ConfirmDialog
        open={changeServerOpen}
        onOpenChange={setChangeServerOpen}
        title="Change chat server?"
        description="This returns you to the server setup screen. You may need to sign in again for the selected server."
        confirmLabel="Change server"
        onConfirm={() => {
          void serverNavigation?.resetServer?.();
        }}
        testIDPrefix="change-server"
      />
    </>
  );
}
