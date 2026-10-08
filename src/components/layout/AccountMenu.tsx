import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarClock,
  ChevronsUpDown,
  Info,
  LogOut,
  ServerCog,
  Settings,
  ShieldCheck,
  Smile,
  UserPlus,
  Webhook,
  X,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { isAdmin, isGuest } from '@/lib/roles';
import { getCapacitorPlugin, isNativePlatform } from '@/lib/capacitor';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { CustomEmojiDialog } from '@/components/emoji/CustomEmojiDialog';
import { UserStatusDialog } from '@/components/UserStatusDialog';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { PresenceDot } from '@/components/PresenceDot';
import { presenceNotchStyle } from '@/lib/presence';
import { activeStatus, formatStatusUntilShort } from '@/lib/user-status';
import { localTimeZone } from '@/lib/user-time';
import { apiFetch, getAccessToken } from '@/lib/api';
import { showToast } from '@/lib/toast';
import type { User } from '@/types';
import { AboutDialog } from '@/components/AboutDialog';
import { InviteDialog } from '@/components/InviteDialog';
import { MOBILE_TAB_CLASS } from './mobile-tab';

interface MenuAction {
  key: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  testID?: string;
  separatorBefore?: boolean;
  // Opens a dialog over the account sheet rather than leaving it: closing
  // that dialog (Done) lands back on the sheet.
  overSheet?: boolean;
}

/**
 * Account footer pinned to the bottom of the sidebar (avatar, name, chevron),
 * like the Claude app. It opens the menu of every user-facing action —
 * Settings, status, invites, custom emojis (a pop-up), admin, change server, about and
 * sign-out — as an upward dropdown on desktop and a full-screen sheet on
 * mobile. Both surfaces render the same `menuActions` list.
 */
interface AccountMenuProps {
  // 'footer' (default): the avatar + name row at the bottom of the sidebar.
  // 'tab': the "You" button in the mobile bottom tab bar — same sheet.
  variant?: 'footer' | 'tab';
}

export function AccountMenu({ variant = 'footer' }: AccountMenuProps) {
  const { user, logout, setAuth } = useAuth();
  const { online } = usePresence();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [emojisOpen, setEmojisOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [changeServerOpen, setChangeServerOpen] = useState(false);
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

  const status = activeStatus(user?.userStatus);

  // The ✕ on the menu's status row: clear the custom status in place, without
  // opening the status dialog.
  async function clearStatus() {
    try {
      const updated = await apiFetch<User>('/api/v1/users/me/status', {
        method: 'DELETE',
        body: JSON.stringify({ timeZone: localTimeZone() }),
      });
      const token = getAccessToken();
      if (token) setAuth(token, updated);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to clear status', 'error');
    }
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  const menuActions: MenuAction[] = [
    {
      key: 'settings',
      icon: <Settings className="h-4 w-4" />,
      label: 'Settings',
      onSelect: () => setSettingsOpen(true),
      overSheet: true,
      testID: 'user-menu-settings',
    },
    // While a status is active the status row at the top of the menu takes
    // this entry's place (click it to edit, ✕ to clear).
    ...(!status
      ? [
          {
            key: 'status',
            icon: <CalendarClock className="h-4 w-4" />,
            label: 'Set status',
            onSelect: () => setStatusOpen(true),
      overSheet: true,
            testID: 'user-menu-set-status',
          } satisfies MenuAction,
        ]
      : []),
    ...(isAdmin(user?.systemRole)
      ? [
          {
            key: 'invite',
            icon: <UserPlus className="h-4 w-4" />,
            label: 'Invite people',
            onSelect: () => setInviteOpen(true),
      overSheet: true,
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
            onSelect: () => setEmojisOpen(true),
      overSheet: true,
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
            icon: <ShieldCheck className="h-4 w-4" />,
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
      overSheet: true,
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
    // could swallow it. Committing the navigation first avoids that race.
    action.onSelect();
    if (!action.overSheet) setMobileMenuOpen(false);
  }

  const triggerClass =
    'flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40 data-[popup-open]:bg-sidebar-accent mobile:h-12';

  const triggerContent = (
    <>
      <span className="relative inline-flex shrink-0">
        <Avatar className="size-7" style={presenceNotchStyle(9)}>
          <AvatarImage src={user?.avatarURL} alt="" />
          <AvatarFallback className="bg-foreground/10 text-foreground text-[11px]">{initials}</AvatarFallback>
        </Avatar>
        <PresenceDot online={userOnline} size={9} inset={0} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm font-medium">{user?.displayName}</span>
        {/* Active custom status (emoji) sits right after the name. */}
        {/* Hover shows the same status card as in chat. The trigger renders as
            a <span> because it sits inside the menu-trigger button. */}
        <UserStatusIndicator status={user?.userStatus} inlineTrigger />
      </span>
      <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </>
  );

  const trigger =
    variant === 'tab' ? (
      <button
        type="button"
        onClick={() => setMobileMenuOpen(true)}
        aria-label="You"
        data-testid="mobile-tab-you"
        className={`${MOBILE_TAB_CLASS} ${mobileMenuOpen ? 'text-sidebar-foreground' : 'text-muted-foreground'}`}
      >
        <span className="relative inline-flex">
          <Avatar className="size-6" style={presenceNotchStyle(8)}>
            <AvatarImage src={user?.avatarURL} alt="" />
            <AvatarFallback className="bg-foreground/10 text-foreground text-[9px]">{initials}</AvatarFallback>
          </Avatar>
          <PresenceDot online={userOnline} size={8} inset={0} />
        </span>
        <span>You</span>
      </button>
    ) : null;

  return (
    <>
      {trigger ?? (
      <div
        className="shrink-0 border-t border-sidebar-border p-2 mobile:pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
        data-testid="sidebar-account"
      >
        {isMobile ? (
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Account menu"
            data-testid="account-menu-trigger"
            className={triggerClass}
          >
            {triggerContent}
          </button>
        ) : (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger aria-label="Account menu" data-testid="account-menu-trigger" className={triggerClass}>
              {triggerContent}
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={6} className="min-w-56">
              {status && (
                <>
                  <div className="flex items-center gap-0.5" data-testid="user-menu-status-row">
                    <DropdownMenuItem
                      onClick={() => setStatusOpen(true)}
                      className="min-w-0 flex-1 items-start gap-2 py-1.5"
                      data-testid="user-menu-status"
                    >
                      <UserStatusIndicator status={status} tooltip={false} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="block truncate">{status.text}</span>
                        <span className="block text-xs text-muted-foreground">{formatStatusUntilShort(status.clearAt)}</span>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      closeOnClick={false}
                      onClick={() => void clearStatus()}
                      aria-label="Clear status"
                      className="size-8 shrink-0 justify-center p-0 text-muted-foreground"
                      data-testid="user-menu-clear-status"
                    >
                      <X className="h-4 w-4" />
                    </DropdownMenuItem>
                  </div>
                  <DropdownMenuSeparator />
                </>
              )}
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
      )}

      {/* Mobile-only full-screen account sheet — same actions as the dropdown. */}
      <Dialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <DialogContent className="not-mobile:hidden mobile:content-start" mobileCloseLabel="Close" data-testid="mobile-account-sheet">
          <DialogHeader>
            <DialogTitle>Account</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
            <Avatar className="h-10 w-10">
              <AvatarImage src={user?.avatarURL} alt="" />
              <AvatarFallback className="bg-muted text-foreground text-sm">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {user?.displayName}
                <UserStatusIndicator status={user?.userStatus} tooltip={false} className="ml-1" />
              </p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
            </div>
          </div>
          {status && (
            <div className="flex items-center gap-1 rounded-lg border px-1" data-testid="mobile-status-row">
              <button
                type="button"
                onClick={() => setStatusOpen(true)}
                className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted"
                data-testid="mobile-status"
              >
                <UserStatusIndicator status={status} tooltip={false} />
                <span className="min-w-0">
                  <span className="block truncate text-base">{status.text}</span>
                  <span className="block text-xs text-muted-foreground">{formatStatusUntilShort(status.clearAt)}</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void clearStatus()}
                aria-label="Clear status"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                data-testid="mobile-clear-status"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
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

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <CustomEmojiDialog open={emojisOpen} onOpenChange={setEmojisOpen} />
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
