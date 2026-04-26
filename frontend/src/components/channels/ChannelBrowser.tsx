import { useNavigate } from 'react-router-dom';
import { Hash } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useBrowseChannels, useJoinChannel, useUserChannels } from '@/hooks/useChannels';

interface ChannelBrowserProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelBrowser({ open, onOpenChange }: ChannelBrowserProps) {
  const { data: allChannels, isLoading } = useBrowseChannels();
  const { data: userChannels } = useUserChannels();
  const joinChannel = useJoinChannel();
  const navigate = useNavigate();

  const joinedIds = new Set(userChannels?.map((c) => c.channelID) ?? []);

  function handleJoin(channelId: string, channelSlug: string) {
    // Routes use slug — passing the id would land on a 404 since
    // ChannelView resolves :id as a slug.
    joinChannel.mutate(channelId, {
      onSuccess: () => {
        onOpenChange(false);
        navigate(`/channel/${channelSlug}`);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Browse channels</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[400px]">
          {isLoading && (
            <div className="space-y-3 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )}

          {allChannels?.length === 0 && (
            <p className="py-8 text-center text-muted-foreground">
              No channels available
            </p>
          )}

          <div className="space-y-1 p-1">
            {allChannels
              ?.filter((ch) => ch.type === 'public')
              .map((channel) => {
                const alreadyJoined = joinedIds.has(channel.id);
                return (
                  <div
                    key={channel.id}
                    className="flex items-center gap-3 rounded-md p-2 hover:bg-muted/50"
                  >
                    <Hash className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {channel.name}
                      </p>
                      {channel.description && (
                        <p className="text-xs text-muted-foreground truncate">
                          {channel.description}
                        </p>
                      )}
                    </div>
                    {alreadyJoined ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          onOpenChange(false);
                          navigate(`/channel/${channel.slug}`);
                        }}
                      >
                        Open
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleJoin(channel.id, channel.slug)}
                        disabled={joinChannel.isPending}
                      >
                        Join
                      </Button>
                    )}
                  </div>
                );
              })}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
