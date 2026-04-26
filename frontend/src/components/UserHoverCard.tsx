import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { MessageSquare } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { getInitials } from '@/lib/format';
import { PopoverPortal } from '@/components/PopoverPortal';
import type { Conversation } from '@/types';

interface UserHoverCardProps {
  userId: string;
  displayName: string;
  avatarURL?: string;
  online?: boolean;
  currentUserId?: string;
  children: ReactNode;
}

const SHOW_DELAY = 350;
const HIDE_DELAY = 150;

export function UserHoverCard({
  userId,
  displayName,
  avatarURL,
  online,
  currentUserId,
  children,
}: UserHoverCardProps) {
  const [open, setOpen] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const navigate = useNavigate();

  const startDM = useMutation({
    mutationFn: () =>
      apiFetch<Conversation>('/api/v1/conversations', {
        method: 'POST',
        body: JSON.stringify({ type: 'dm', participantIDs: [userId] }),
      }),
    onSuccess: (conv) => {
      navigate(`/conversation/${conv.id}`);
      setOpen(false);
    },
  });

  function clearTimers() {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }

  function handleEnter() {
    clearTimers();
    showTimer.current = setTimeout(() => setOpen(true), SHOW_DELAY);
  }

  function handleLeave() {
    clearTimers();
    hideTimer.current = setTimeout(() => setOpen(false), HIDE_DELAY);
  }

  useEffect(() => () => clearTimers(), []);

  const isSelf = currentUserId === userId;

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-block"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {children}
      </span>
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={() => setOpen(false)}
        estimatedHeight={180}
        estimatedWidth={256}
        preferredSide="bottom"
        preferredAlign="start"
        role="tooltip"
        className="w-64 rounded-md border bg-popover p-3 shadow-lg"
      >
        <div onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Avatar className="h-12 w-12">
                {avatarURL && <AvatarImage src={avatarURL} alt="" />}
                <AvatarFallback className="bg-primary/10 text-sm">
                  {getInitials(displayName)}
                </AvatarFallback>
              </Avatar>
              {online !== undefined && (
                <span
                  className={`absolute bottom-0 right-0 h-3 w-3 rounded-full ring-2 ring-popover ${
                    online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                  }`}
                  aria-label={online ? 'Online' : 'Offline'}
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-semibold">{displayName}</p>
              <p className="text-xs text-muted-foreground">
                {online === undefined ? '' : online ? 'Online' : 'Offline'}
              </p>
            </div>
          </div>
          {!isSelf && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3 w-full"
              onClick={() => startDM.mutate()}
              disabled={startDM.isPending}
            >
              <MessageSquare className="mr-2 h-3.5 w-3.5" />
              Direct message
            </Button>
          )}
        </div>
      </PopoverPortal>
    </>
  );
}
