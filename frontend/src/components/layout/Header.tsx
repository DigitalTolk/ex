import { useState } from 'react';
import { Hash, Lock, Users, ChevronDown, LogOut, Archive, Pencil, Bell, BellOff } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getInitials } from '@/lib/format';
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
import type { Channel } from '@/types';

interface HeaderProps {
  channel?: Channel;
  memberCount?: number;
  title?: string;
  subtitle?: string;
  avatarURL?: string;
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
}

export function Header({
  channel,
  memberCount,
  title,
  subtitle,
  avatarURL,
  onMembersClick,
  canEdit,
  onDescriptionSave,
  canArchive,
  onArchive,
  canLeave,
  onLeave,
  muted,
  onToggleMute,
}: HeaderProps) {
  const displayTitle = channel?.name ?? title ?? '';
  const isPrivate = channel?.type === 'private';

  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  return (
    <header className="flex items-center gap-3 border-b px-4 py-3">
      <div className="flex items-center gap-2">
        {channel ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 hover:bg-muted/50 rounded-md px-1 -ml-1">
              {isPrivate ? (
                <Lock className="h-5 w-5 text-muted-foreground" aria-label="Private channel" />
              ) : (
                <Hash className="h-5 w-5 text-muted-foreground" aria-label="Public channel" />
              )}
              <h1 className="text-lg font-semibold">{displayTitle}</h1>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {canEdit && (
                <DropdownMenuItem
                  onClick={() => {
                    setDescDraft(channel?.description || '');
                    setIsEditingDesc(true);
                  }}
                >
                  <Pencil className="mr-2 h-4 w-4" /> Edit description
                </DropdownMenuItem>
              )}
              {onToggleMute && (
                <DropdownMenuItem onClick={onToggleMute} aria-label={muted ? 'Unmute channel' : 'Mute channel'}>
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
                <DropdownMenuItem onClick={onLeave}>
                  <LogOut className="mr-2 h-4 w-4" /> Leave channel
                </DropdownMenuItem>
              )}
              {canArchive && (
                <DropdownMenuItem
                  onClick={() => setArchiveConfirmOpen(true)}
                  className="text-destructive"
                >
                  <Archive className="mr-2 h-4 w-4" /> Archive channel
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="flex items-center gap-2">
            {avatarURL !== undefined && (
              <Avatar className="h-7 w-7">
                <AvatarImage src={avatarURL} alt="" />
                <AvatarFallback className="bg-primary/10 text-[10px]">
                  {getInitials(displayTitle || '??')}
                </AvatarFallback>
              </Avatar>
            )}
            <div>
              <h1 className="text-lg font-semibold">{displayTitle}</h1>
              {subtitle && (
                <p className="text-xs text-muted-foreground">{subtitle}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {channel && (
        isEditingDesc ? (
          <input
            className="hidden text-sm border-b border-input bg-transparent outline-none sm:inline"
            value={descDraft}
            onChange={e => setDescDraft(e.target.value)}
            onBlur={() => { onDescriptionSave?.(descDraft); setIsEditingDesc(false); }}
            onKeyDown={e => { if (e.key === 'Enter') { onDescriptionSave?.(descDraft); setIsEditingDesc(false); } if (e.key === 'Escape') setIsEditingDesc(false); }}
            placeholder="Add a description..."
            autoFocus
          />
        ) : channel.description ? (
          canEdit ? (
            <button
              onClick={() => { setDescDraft(channel.description || ''); setIsEditingDesc(true); }}
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
              title="Click to edit description"
            >
              {channel.description}
            </button>
          ) : (
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {channel.description}
            </span>
          )
        ) : null
      )}

      <div className="ml-auto flex items-center gap-2">
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
    </header>
  );
}
