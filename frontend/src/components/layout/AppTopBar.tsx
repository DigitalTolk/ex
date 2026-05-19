import { useState } from 'react';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SearchBar } from '@/components/SearchBar';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { isAdmin, isGuest } from '@/lib/roles';
import { getCapacitorPlugin, isNativePlatform } from '@/lib/capacitor';
import { EditProfileDialog } from '@/components/EditProfileDialog';
import { UserStatusDialog } from '@/components/UserStatusDialog';
import { AboutDialog } from '@/components/AboutDialog';
import { InviteDialog } from '@/components/InviteDialog';
import { EmojiManagerDialog } from '@/components/EmojiManagerDialog';

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
export function AppTopBar({ onOpenChannels, channelsButtonHidden }: AppTopBarProps) {
  const { user, logout } = useAuth();
  const { online } = usePresence();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [emojiManagerOpen, setEmojiManagerOpen] = useState(false);
  const [changeServerOpen, setChangeServerOpen] = useState(false);

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

  return (
    <>
      <header
        // Compact macOS title-bar-style strip: 36px tall, minimal
        // horizontal padding, just enough vertical room for the
        // search pill and avatar. The container is draggable-as-a-
        // titlebar on native via Capacitor (CSS hook below).
        className="grid h-9 w-full shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border bg-sidebar px-2 text-sidebar-foreground [-webkit-app-region:drag] [&_button,&_a,&_input]:[-webkit-app-region:no-drag]"
        data-testid="app-shell-header"
        data-app-chrome="true"
      >
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenChannels}
            aria-label="Open channels"
            aria-hidden={channelsButtonHidden}
            tabIndex={channelsButtonHidden ? -1 : 0}
            className={`h-7 w-7 text-sidebar-foreground hover:bg-sidebar-accent lg:hidden ${channelsButtonHidden ? 'invisible' : ''}`}
          >
            <Menu className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-w-0 w-full max-w-xl justify-self-center mx-auto">
          <SearchBar />
        </div>

        <div className="flex items-center justify-end">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              className="relative inline-flex h-7 w-7 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label="Account menu"
              data-testid="topbar-account"
            >
              <Avatar className="h-6 w-6">
                <AvatarImage src={user?.avatarURL} alt="" />
                <AvatarFallback className="bg-muted text-foreground text-[10px]">{initials}</AvatarFallback>
              </Avatar>
              <span
                aria-hidden
                className={`absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-sidebar ${userOnline ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setProfileOpen(true)}>
                <UserIcon className="mr-2 h-4 w-4" />
                Edit profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusOpen(true)}>
                <CalendarClock className="mr-2 h-4 w-4" />
                Set status
              </DropdownMenuItem>
              {isAdmin(user?.systemRole) && (
                <DropdownMenuItem onClick={() => setInviteOpen(true)} data-testid="user-menu-invite">
                  <UserPlus className="mr-2 h-4 w-4" />
                  Invite people
                </DropdownMenuItem>
              )}
              {!isGuest(user?.systemRole) && (
                <DropdownMenuItem onClick={() => setEmojiManagerOpen(true)} data-testid="user-menu-emojis">
                  <Smile className="mr-2 h-4 w-4" />
                  Custom emojis
                </DropdownMenuItem>
              )}
              {isAdmin(user?.systemRole) && (
                <DropdownMenuItem onClick={() => navigate('/admin')} data-testid="user-menu-admin">
                  <Settings className="mr-2 h-4 w-4" />
                  Admin
                </DropdownMenuItem>
              )}
              {serverNavigation && (
                <DropdownMenuItem onClick={() => setChangeServerOpen(true)} data-testid="user-menu-change-server">
                  <ServerCog className="mr-2 h-4 w-4" />
                  Change server
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAboutOpen(true)} data-testid="user-menu-about">
                <Info className="mr-2 h-4 w-4" />
                About Server
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} data-testid="user-menu-signout">
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <EditProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
      <UserStatusDialog
        key={`${user?.id ?? ''}:${user?.userStatus?.emoji ?? ''}:${user?.userStatus?.text ?? ''}:${user?.userStatus?.clearAt ?? ''}`}
        open={statusOpen}
        onOpenChange={setStatusOpen}
      />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <EmojiManagerDialog open={emojiManagerOpen} onOpenChange={setEmojiManagerOpen} />
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
