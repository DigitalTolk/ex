import { useLayoutEffect, useRef, useState } from 'react';
import { Users, ChevronDown, LogOut, Archive, Pencil, Bell, BellOff, Pin, Paperclip } from 'lucide-react';
import { ChannelIcon } from '@/components/ChannelIcon';
import { UserAvatar } from '@/components/UserAvatar';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import { UserHoverCard } from '@/components/UserHoverCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { useIsMobile } from '@/hooks/useIsMobile';
import type { Channel, UserStatus } from '@/types';

interface HeaderProps {
  channel?: Channel;
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
  userId?: string;
  currentUserId?: string;
  onMembersClick?: () => void;
  channelId?: string;
  canEdit?: boolean;
  onDescriptionSave?: (desc: string) => void;
  canArchive?: boolean;
  onArchive?: () => void;
  canLeave?: boolean;
  onLeave?: () => void;
  muted?: boolean;
  onToggleMute?: () => void;
  onPinnedClick?: () => void;
  pinnedActive?: boolean;
  onFilesClick?: () => void;
  filesActive?: boolean;
}

export function Header({
  channel,
  memberCount,
  title,
  subtitle,
  avatarURL,
  avatarOnline,
  showAvatar,
  userStatus,
  userId,
  currentUserId,
  onMembersClick,
  canEdit,
  onDescriptionSave,
  canArchive,
  onArchive,
  canLeave,
  onLeave,
  muted,
  onToggleMute,
  onPinnedClick,
  pinnedActive,
  onFilesClick,
  filesActive,
}: HeaderProps) {
  const displayTitle = channel?.name ?? title ?? '';

  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [mobileChannelMenuOpen, setMobileChannelMenuOpen] = useState(false);
  const headerShellRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useLayoutEffect(() => {
    const node = headerShellRef.current;
    /* v8 ignore next -- headerShellRef is always attached and document always exists in this browser-only app; defensive guards */
    if (!node || typeof document === 'undefined') return;
    const measuredNode = node;

    function updateMobilePanelTop() {
      const bottom = measuredNode.getBoundingClientRect().bottom;
      const containingBlockTop =
        measuredNode.closest<HTMLElement>('[data-app-main="true"]')?.getBoundingClientRect().top ?? 0;
      const panelTop = Math.max(0, bottom - containingBlockTop);
      document.documentElement.style.setProperty('--mobile-right-panel-top', `${Number(panelTop.toFixed(2))}px`);
    }

    updateMobilePanelTop();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateMobilePanelTop);
    resizeObserver?.observe(measuredNode);
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
      document.documentElement.style.removeProperty('--mobile-right-panel-top');
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

  function cancelDescriptionEdit() {
    setIsEditingDesc(false);
  }

  function toggleMute() {
    onToggleMute?.();
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

  return (
    <div ref={headerShellRef} className="shrink-0 border-b bg-background" data-testid="channel-header-shell">
    <header className="flex shrink-0 items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {channel ? (
          <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="channel-title-stack">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                className="-ml-1 flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 hover:bg-muted/50"
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
              <DropdownMenuContent align="start" className="w-56 max-md:hidden">
                {canEdit && (
                  <DropdownMenuItem
                    onClick={editDescription}
                  >
                    <Pencil className="mr-2 h-4 w-4" /> Edit description
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
                {canLeave && (
                  <DropdownMenuItem onClick={leaveChannel}>
                    <LogOut className="mr-2 h-4 w-4" /> Leave channel
                  </DropdownMenuItem>
                )}
                {canArchive && (
                  <DropdownMenuItem
                    onClick={confirmArchive}
                    className="text-destructive"
                  >
                    <Archive className="mr-2 h-4 w-4" /> Archive channel
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
                  onKeyDown={e => { if (e.key === 'Enter') saveDescription(); if (e.key === 'Escape') cancelDescriptionEdit(); }}
                  placeholder="Add a description..."
                  autoFocus
                />
              ) : channel.description ? (
                canEdit ? (
                  <button
                    /* v8 ignore next -- this branch only renders when channel.description is truthy, so the || '' fallback is dead */
                    onClick={() => { setDescDraft(channel.description || ''); setIsEditingDesc(true); }}
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
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            {userId ? (
              <div className="min-w-0">
                <UserHoverCard
                  userId={userId}
                  displayName={displayTitle}
                  avatarURL={avatarURL}
                  userStatus={userStatus}
                  online={avatarOnline}
                  currentUserId={currentUserId}
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
                    <h1 className="min-w-0 truncate text-lg font-semibold">{displayTitle}</h1>
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
          /* v8 ignore next -- the dialog is controlled (open={isEditingDesc}); radix only calls onOpenChange(false) on user dismiss, never with open=true, so the open=true arm is unreachable */
          if (!open) cancelDescriptionEdit();
        }}>
          <DialogContent className="max-w-none" data-testid="mobile-description-editor">
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
            <div className="mt-auto flex gap-2">
              <Button type="button" variant="ghost" className="flex-1" onClick={cancelDescriptionEdit}>
                Cancel
              </Button>
              <Button type="button" className="flex-1" onClick={saveDescription}>
                Save
              </Button>
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
            <Badge variant="secondary" className="gap-1 cursor-pointer hover:bg-secondary/80">
              <Users className="h-3 w-3" aria-hidden="true" />
              {memberCount}
            </Badge>
          </button>
        )}
      </div>
    </header>

      {channel && mobileChannelMenuOpen && (
        <div id="mobile-channel-menu" className="border-t px-2 py-2 text-base md:hidden" data-testid="mobile-channel-menu">
          {canEdit && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={editDescription}
            >
              <Pencil className="mr-2 h-4 w-4" /> Edit description
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
          {canLeave && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left hover:bg-muted"
              onClick={leaveChannel}
            >
              <LogOut className="mr-2 h-4 w-4" /> Leave channel
            </button>
          )}
          {canArchive && (
            <button
              type="button"
              className="flex h-12 w-full items-center rounded-md px-3 text-left text-destructive hover:bg-muted"
              onClick={confirmArchive}
            >
              <Archive className="mr-2 h-4 w-4" /> Archive channel
            </button>
          )}
        </div>
      )}

      {/* Archive confirmation dialog */}
      <Dialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Archive channel?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will hide the channel for all members. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setArchiveConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setArchiveConfirmOpen(false);
                onArchive?.();
              }}
            >
              Archive
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
