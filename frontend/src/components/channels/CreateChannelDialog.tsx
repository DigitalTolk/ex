import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCreateChannel } from '@/hooks/useChannels';

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
}: CreateChannelDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const createChannel = useCreateChannel();
  const navigate = useNavigate();

  function reset() {
    setName('');
    setDescription('');
    setIsPrivate(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    createChannel.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        type: isPrivate ? 'private' : 'public',
      },
      {
        onSuccess: (channel) => {
          reset();
          onOpenChange(false);
          navigate(`/channel/${channel.slug}`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="channel-name">Name</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. marketing"
              required
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="channel-desc">
              Description{' '}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="channel-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this channel about?"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="channel-private">Make private</Label>
              <p className="text-xs text-muted-foreground">
                Only invited members can see this channel
              </p>
            </div>
            <Switch
              id="channel-private"
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createChannel.isPending}>
              {createChannel.isPending ? 'Creating...' : 'Create Channel'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
