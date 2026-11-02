import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Users, ChevronDown, ChevronLeft, LogOut, Archive, ArchiveRestore, Pencil, TextCursorInput, Bell, BellOff, Pin, Paperclip, SlidersHorizontal, Lock } from 'lucide-react';
import { ChannelIcon } from '@/components/ChannelIcon';
import { UserAvatar } from '@/components/UserAvatar';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { UserHoverCard } from '@/components/UserHoverCard';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useIsMobile } from '@/hooks/useIsMobile';
import { requestOpenChannels } from '@/lib/mobile-nav';
import type { Channel, UserStatus } from '@/types';

interface HeaderProps {
  channel?: Channel;
  // While a channel is still loading: its name and type when already known
  // (from the sidebar), otherwise a placeholder bar.
  loadingChannel?: { name?: string; type?: Channel['type'] };
  memberCount?: number;
  title?: string;
  subtitle?: string;
  avatarURL?: string;
  avatarOnline?: boolean;
  // When true, always render an Avatar in non-channel mode — falling
  // back to initials when avatarURL is missing. Without this, switching
  // from a DM whose partner has an avatar to a DM whose partner has
  // none leaves the avatar slot blank. Pass false (the default) for
  // group conversations where no single avatar represents the room.
  showAvatar?: boolean;
  userStatus?: UserStatus;
  // A DM with a deactivated account: marked as inactive by the title.
  inactive?: boolean;
  userId?: string;
  currentUserId?: string;
  onMembersClick?: () => void;
  channelId?: string;
  canEdit?: boolean;
  onDescriptionSave?: (desc: string) => void;
  // Opens the rename dialog; absent where the channel can't be renamed.
  onRename?: () => void;
  // Makes a public channel private (after a confirm); absent where that
  // isn't offered.
  onMakePrivate?: () => void;
  canArchive?: boolean;
  onArchive?: () => void;
  // An archived channel offers Unarchive in place of Archive.
  canUnarchive?: boolean;
  onUnarchive?: () => void;
  canLeave?: boolean;
  onLeave?: () => void;
  muted?: boolean;
  onToggleMute?: () => void;
  onNotificationPrefsClick?: () => void;
  onPinnedClick?: () => void;
  pinnedActive?: boolean;
  onFilesClick?: () => void;
  filesActive?: boolean;
  // A group message: its title opens a menu to make it a private channel.
  onConvertToChannel?: () => void;
}

// Memoized: the chat views re-render often (queries resolving, typing) and
// hand it stable callbacks, so it re-renders only when what it shows changes.
export const Header = memo(function Header({
  channel,
  loadingChannel,
  memberCount,
  title,
  subtitle,
  avatarURL,
  avatarOnline,
  showAvatar,
  userStatus,
  inactive,
  userId,
  currentUserId,
  onMembersClick,
  canEdit,
  onDescriptionSave,
  onRename,
  onMakePrivate,
  canArchive,
  onArchive,
  canUnarchive,
  onUnarchive,
  canLeave,
  onLeave,
  muted,
  onToggleMute,
  onNotificationPrefsClick,
  onPinnedClick,
  pinnedActive,
  onFilesClick,
  filesActive,
  onConvertToChannel,
}: HeaderProps) {
  const displayTitle = channel?.name ?? title ?? '';

  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [privateConfirmOpen, setPrivateConfirmOpen] = useState(false);
  const [mobileChannelMenuOpen, setMobileChannelMenuOpen] = useState(false);
  const headerShellRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useLayoutEffect(() => {
    const node = headerShellRef.current;
    /* istanbul ignore next -- headerShellRef is always attached and document always exists in this browser-only app; defensive guards */
    if (!node || typeof document === 'undefined') return;
    const measuredNode = node;
    const main = measuredNode.closest<HTMLElement>('[data-app-main="true"]');
    // Published on main, where the panels are, and only when it changes: a
    // custom property inherits into everything below the element it is set
    // on, so each write to the document root restyled the whole page (the
    // sidebar's rows included) as a conversation opened or closed.
    const host = main ?? document.documentElement;

    function updateMobilePanelTop() {
      const bottom = measuredNode.getBoundingClientRect().bottom;
      const containingBlockTop = main?.getBoundingClientRect().top ?? 0;
      const panelTop = `${Number(Math.max(0, bottom - containingBlockTop).toFixed(2))}px`;
      if (host.style.getPropertyValue('--mobile-right-panel-top') !== panelTop) {
        host.style.setProperty('--mobile-right-panel-top', panelTop);
      }
    }

    updateMobilePanelTop();
    /* istanbul ignore next -- ResizeObserver is always defined in the supported browsers; the null arm is a defensive feature-detect */
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateMobilePanelTop);
    resizeObserver?.observe(measuredNode);
    /* istanbul ignore next -- MutationObserver is always defined in the supported browsers; the null arm is a defensive feature-detect */
    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => requestAnimationFrame(updateMobilePanelTop));
    mutationObserver?.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.addEventListener('resize', updateMobilePanelTop);
    window.visualViewport?.addEventListener('resize', updateMobilePanelTop);
    window.visualViewport?.addEventListener('scroll', updateMobilePanelTop);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', updateMobilePanelTop);
      window.visualViewport?.removeEventListener('resize', updateMobilePanelTop);
      window.visualViewport?.removeEventListener('scroll', updateMobilePanelTop);
      host.style.removeProperty('--mobile-right-panel-top');
    };
  }, []);

  function editDescription() {
    setDescDraft(channel?.description || '');
    setIsEditingDesc(true);
    setMobileChannelMenuOpen(false);
  }

  function saveDescription() {
    onDescriptionSave?.(descDraft);
    setIsEditingDesc(false);
  }

  function renameChannel() {
    setMobileChannelMenuOpen(false);
    onRename?.();
  }

  function confirmMakePrivate() {
    setPrivateConfirmOpen(true);
    setMobileChannelMenuOpen(false);
  }

  function cancelDescriptionEdit() {
    setIsEditingDesc(false);
  }

  function toggleMute() {
    onToggleMute?.();
    setMobileChannelMenuOpen(false);
  }

  function openNotificationPrefs() {
    onNotificationPrefsClick?.();
    setMobileChannelMenuOpen(false);
  }

  function leaveChannel() {
    onLeave?.();
    setMobileChannelMenuOpen(false);
  }

  function confirmArchive() {
    setArchiveConfirmOpen(true);
    setMobileChannelMenuOpen(false);
  }

  function unarchiveChannel() {
    onUnarchive?.();
    setMobileChannelMenuOpen(false);
  }

  const archived = !!channel?.archived;
  const showArchive = !!canArchive && !archived;
  const showUnarchive = !!canUnarchive && archived;

  return (
    <div ref={headerShellRef} className="shrink-0 border-b bg-background" data-testid="channel-header-shell">
    <header className="flex shrink-0 items-center gap-3 px-4 py-3 mobile:gap-1 mobile:pl-1">
      {/* Phone: the back button lives here, so the screen has no separate
          top bar — the header is the top edge. */}
      {isMobile && (
        <button
          type="button"
          onClick={requestOpenChannels}
          aria-label="Back"
          className="-my-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-foreground active:bg-muted"
          data-testid="mobile-header-back"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {channel ? (
          <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="channel-title-stack">
            <DropdownMenu modal={false}>
              {/* shrink-0: the description beside it takes what the name
                  leaves. Both shrinking, flexbox squeezed them in proportion
                  to their length, and a long description left "in…" of the
                  name. max-w-full still truncates a name too long alone. */}
              <DropdownMenuTrigger
                className="-ml-1 flex min-w-0 max-w-full shrink-0 items-center gap-1 rounded-md px-1 hover:bg-muted/50"
                onClick={() => {
                  if (isMobile) setMobileChannelMenuOpen((open) => !open);
                }}
                aria-expanded={isMobile ? mobileChannelMenuOpen : undefined}
                aria-controls={isMobile ? 'mobile-channel-menu' : undefined}
              >
                <ChannelIcon type={channel.type} className="h-5 w-5 shrink-0 text-muted-foreground" />
                <h1 className="min-w-0 truncate text-lg font-semibold">{displayTitle}</h1>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56 mobile:hidden">
                {canEdit && (
                  <DropdownMenuItem
                    onClick={editDescription}
                  >
                    <Pencil className="mr-2 h-4 w-4" /> Edit description
                  </DropdownMenuItem>
                )}
                {onRename && (
                  <DropdownMenuItem onClick={renameChannel}>
                    <TextCursorInput className="mr-2 h-4 w-4" /> Rename channel
                  </DropdownMenuItem>
                )}
                {onMakePrivate && (
                  <DropdownMenuItem onClick={confirmMakePrivate}>
                    <Lock className="mr-2 h-4 w-4" /> Make private
                  </DropdownMenuItem>
                )}
                {onToggleMute && (
                  <DropdownMenuItem onClick={toggleMute} aria-label={muted ? 'Unmute channel' : 'Mute channel'}>
                    {muted ? (
                      <>
                        <Bell className="mr-2 h-4 w-4" /> Unmute channel
                      </>
                    ) : (
                      <>
                        <BellOff className="mr-2 h-4 w-4" /> Mute channel
                      </>
                    )}
                  </DropdownMenuItem>
                )}
                {onNotificationPrefsClick && (
                  <DropdownMenuItem onClick={openNotificationPrefs}>
                    <SlidersHorizontal className="mr-2 h-4 w-4" /> Notification preferences
                  </DropdownMenuItem>
                )}
                {canLeave && (
                  <DropdownMenuItem onClick={leaveChannel}>
                    <LogOut className="mr-2 h-4 w-4" /> Leave channel
                  </DropdownMenuItem>
                )}
                {showArchive && (
                  <DropdownMenuItem
                    onClick={confirmArchive}
                    className="text-destructive"
                  >
                    <Archive className="mr-2 h-4 w-4" /> Archive channel
                  </DropdownMenuItem>
                )}
                {showUnarchive && (
                  <DropdownMenuItem onClick={unarchiveChannel}>
                    <ArchiveRestore className="mr-2 h-4 w-4" /> Unarchive channel
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {!isMobile && (
              isEditingDesc ? (
                <input
                  className="hidden min-w-0 max-w-xl flex-1 border-b border-input bg-transparent text-left text-sm outline-none md:block"
                  value={descDraft}
                  onChange={e => setDescDraft(e.target.value)}
                  onBlur={saveDescription}
                  onKeyDown={e => { if (e.key === 'Enter') saveDescription(); if (e.key === 'Escape') { e.preventDefault(); cancelDescriptionEdit(); } }}
                  placeholder="Add a description..."
                  autoFocus
                />
              ) : channel.description ? (
                canEdit ? (
                  <button
                    onClick={editDescription}
                    className="hidden min-w-0 max-w-full truncate text-left text-sm text-muted-foreground hover:text-foreground md:block"
                    title="Click to edit description"
                  >
                    {channel.description}
                  </button>
                ) : (
                  <span className="hidden min-w-0 max-w-full truncate text-left text-sm text-muted-foreground md:block">
                    {channel.description}
                  </span>
                )
              ) : null
            )}
          </div>
        ) : loadingChannel ? (
          <div className="-ml-1 flex h-7 min-w-0 items-center gap-1 px-1" data-testid="channel-title-loading" aria-busy="true">
            {loadingChannel.name ? (
              <>
                <ChannelIcon type={loadingChannel.type ?? 'public'} className="h-5 w-5 shrink-0 text-muted-foreground" />
                <h1 className="min-w-0 truncate text-lg font-semibold">{loadingChannel.name}</h1>
              </>
            ) : (
              <Skeleton className="h-5 w-36" />
            )}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            {userId ? (
              <div className="min-w-0">
                {/* max-w-full: an inline box is never narrower than what's
                    in it, so a long name ran past the header instead of
                    truncating. */}
                <UserHoverCard
                  userId={userId}
                  displayName={displayTitle}
                  avatarURL={avatarURL}
                  userStatus={userStatus}
                  online={avatarOnline}
                  currentUserId={currentUserId}
                  triggerClassName="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 align-middle"
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    {showAvatar && (
                      <UserAvatar
                        key={avatarURL ?? '__none__'}
                        displayName={displayTitle || '??'}
                        avatarURL={avatarURL}
                        online={avatarOnline}
                        className="h-7 w-7 shrink-0"
                      />
                    )}
                    <h1 className="min-w-0 truncate text-lg font-semibold">{displayTitle}</h1>
                    {inactive && (
                      <Badge variant="destructive" data-testid="header-status-inactive">
                        Inactive
                      </Badge>
                    )}
                  </span>
                </UserHoverCard>
                {subtitle && (
                  <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                )}
              </div>
            ) : (
              <>
                {showAvatar && (
                  // Keyed on avatarURL so AvatarImage's internal load state
                  // resets when switching between DMs — otherwise a previous
                  // load can keep the fallback hidden when the new partner
                  // has no image.
                  <UserAvatar
                    key={avatarURL ?? '__none__'}
                    displayName={displayTitle || '??'}
                    avatarURL={avatarURL}
                    online={avatarOnline}
                    className="h-7 w-7 shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {onConvertToChannel ? (
                      <DropdownMenu modal={false}>
                        {/* No max-w-full: in this content-sized row, 100% is
                            the trigger's own width less its -ml-1, which cut
                            the last letters off every group title. min-w-0
                            still lets it shrink when the title doesn't fit. */}
                        <DropdownMenuTrigger
                          className="-ml-1 flex min-w-0 items-center gap-1 rounded-md px-1 hover:bg-muted/50"
                          onClick={() => {
                            if (isMobile) setMobileChannelMenuOpen((open) => !open);
                          }}
                          aria-expanded={isMobile ? mobileChannelMenuOpen : undefined}
                          aria-controls={isMobile ? 'mobile-channel-menu' : undefined}
                          data-testid="conversation-title-menu"
                        >
                          <h1 className="min-w-0 truncate text-lg font-semibold">{displayTitle}</h1>
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-60 mobile:hidden">
                          <DropdownMenuItem onClick={onConvertToChannel}>
                            <Lock className="mr-2 h-4 w-4" /> Convert to private channel
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <h1 className="min-w-0 truncate text-lg font-semibold">{displayTitle}</h1>
                    )}
                    {userStatus && <UserStatusIndicator status={userStatus} />}
                  </div>
                  {subtitle && (
                    <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {channel && isMobile && (
        <Dialog open={isEditingDesc} onOpenChange={(open) => {
          /* istanbul ignore next -- the dialog is controlled (open={isEditingDesc}); radix only calls onOpenChange(false) on user dismiss, never with open=true, so the open=true arm is unreachable */
          if (!open) cancelDescriptionEdit();
        }}>
          {/* Cancel/Save live in the top-right header (the standard mobile
              dialog pattern): the textarea autofocuses, so bottom-row buttons
              sat hidden behind the keyboard. */}
          <DialogContent
            className="max-w-none mobile:grid-rows-[auto_1fr]"
            data-testid="mobile-description-editor"
            mobileCloseLabel="Cancel"
            mobileAction={{ label: 'Save', onClick: saveDescription }}
          >
            <DialogHeader>
              <DialogTitle>Edit channel description</DialogTitle>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <label className="text-sm font-medium" htmlFor="mobile-channel-description">
                Description
              </label>
              <textarea
                id="mobile-channel-description"
                className="min-h-40 w-full resize-none rounded-md border border-input bg-background px-3 py-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder="Add a description..."
                autoFocus
              />
            </div>
          </DialogContent>
        </Dialog>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {onPinnedClick && (
          <button
            onClick={onPinnedClick}
            aria-label="View pinned messages"
            aria-pressed={pinnedActive}
            data-testid="pinned-toggle"
            className={
              'flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted ' +
              (pinnedActive ? 'bg-muted text-foreground' : 'text-muted-foreground')
            }
          >
            <Pin className="h-4 w-4" />
          </button>
        )}
        {onFilesClick && (
          <button
            onClick={onFilesClick}
            aria-label="View shared files"
            aria-pressed={filesActive}
            data-testid="files-toggle"
            className={
              'flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted ' +
              (filesActive ? 'bg-muted text-foreground' : 'text-muted-foreground')
            }
          >
            <Paperclip className="h-4 w-4" />
          </button>
        )}
        {memberCount !== undefined && (
          <button
            onClick={onMembersClick}
            aria-label="Toggle member list"
          >
            <Badge variant="secondary" className="h-7 gap-1 cursor-pointer hover:bg-secondary/80">
              <Users className="h-3 w-3" aria-hidden="true" />
              {memberCount}
            </Badge>
          </button>
        )}
      </div>
    </header>

      {!channel && onConvertToChannel && mobileChannelMenuOpen && (
        <div id="mobile-channel-menu" className="border-t px-2 py-2 text-base not-mobile:hidden" data-testid="mobile-channel-menu">
          <button
            type="button"
            className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
            onClick={() => {
              setMobileChannelMenuOpen(false);
              onConvertToChannel();
            }}
          >
            <Lock className="mr-2 h-4 w-4" /> Convert to private channel
          </button>
        </div>
      )}

      {channel && mobileChannelMenuOpen && (
        <div id="mobile-channel-menu" className="border-t px-2 py-2 text-base not-mobile:hidden" data-testid="mobile-channel-menu">
          {canEdit && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={editDescription}
            >
              <Pencil className="mr-2 h-4 w-4" /> Edit description
            </button>
          )}
          {onRename && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={renameChannel}
            >
              <TextCursorInput className="mr-2 h-4 w-4" /> Rename channel
            </button>
          )}
          {onMakePrivate && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={confirmMakePrivate}
            >
              <Lock className="mr-2 h-4 w-4" /> Make private
            </button>
          )}
          {onToggleMute && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={toggleMute}
              aria-label={muted ? 'Unmute channel' : 'Mute channel'}
            >
              {muted ? <Bell className="mr-2 h-4 w-4" /> : <BellOff className="mr-2 h-4 w-4" />}
              {muted ? 'Unmute channel' : 'Mute channel'}
            </button>
          )}
          {onNotificationPrefsClick && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={openNotificationPrefs}
            >
              <SlidersHorizontal className="mr-2 h-4 w-4" /> Notification preferences
            </button>
          )}
          {canLeave && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={leaveChannel}
            >
              <LogOut className="mr-2 h-4 w-4" /> Leave channel
            </button>
          )}
          {showArchive && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left text-destructive hover:bg-muted"
              onClick={confirmArchive}
            >
              <Archive className="mr-2 h-4 w-4" /> Archive channel
            </button>
          )}
          {showUnarchive && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={unarchiveChannel}
            >
              <ArchiveRestore className="mr-2 h-4 w-4" /> Unarchive channel
            </button>
          )}
        </div>
      )}

      {/* Archive confirmation — the shared ConfirmDialog, so it gets the
          standard mobile chrome (safe-area close, touch-sized buttons)
          instead of a hand-rolled variant. */}
      <ConfirmDialog
        open={archiveConfirmOpen}
        onOpenChange={setArchiveConfirmOpen}
        title="Archive channel?"
        description="Members keep read access to its history, but nobody can post. An owner can unarchive it later."
        confirmLabel="Archive"
        destructive
        onConfirm={() => onArchive?.()}
        testIDPrefix="archive-channel"
      />
      <ConfirmDialog
        open={privateConfirmOpen}
        onOpenChange={setPrivateConfirmOpen}
        title={`Make ~${displayTitle} private?`}
        description="Only its members will see it. This can't be undone."
        confirmLabel="Make private"
        onConfirm={() => onMakePrivate?.()}
        testIDPrefix="private-channel"
      />
    </div>
  );
});
