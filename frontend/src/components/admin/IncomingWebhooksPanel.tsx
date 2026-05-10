import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUserChannels } from '@/hooks/useChannels';
import { useCreateIncomingWebhook, useDeleteIncomingWebhook, useIncomingWebhooks } from '@/hooks/useWebhooks';

export function IncomingWebhooksPanel() {
  const { data: channels = [] } = useUserChannels();
  const { data: webhooks = [] } = useIncomingWebhooks();
  const create = useCreateIncomingWebhook();
  const remove = useDeleteIncomingWebhook();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [channelID, setChannelID] = useState('');
  const [lockToChannel, setLockToChannel] = useState(true);
  const [username, setUsername] = useState('');
  const [profileImageURL, setProfileImageURL] = useState('');

  const selectedChannelID = channelID || channels[0]?.channelID || '';

  function submit() {
    create.mutate({
      title: title.trim(),
      description: description.trim(),
      channelID: selectedChannelID,
      lockToChannel,
      username: username.trim(),
      profileImageURL: profileImageURL.trim(),
    }, {
      onSuccess: () => {
        setTitle('');
        setDescription('');
        setUsername('');
        setProfileImageURL('');
      },
    });
  }

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5">
      <div>
        <h2 className="text-base font-semibold">Incoming webhooks</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Create Mattermost-compatible webhook URLs for posting into channels.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="webhook-title">Title</Label>
          <Input id="webhook-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="webhook-channel">Channel</Label>
          <select
            id="webhook-channel"
            value={selectedChannelID}
            onChange={(e) => setChannelID(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          >
            {channels.map((ch) => (
              <option key={ch.channelID} value={ch.channelID}>
                {ch.channelName}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="webhook-description">Description</Label>
          <Input id="webhook-description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="webhook-username">Username</Label>
          <Input id="webhook-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="webhook" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="webhook-picture">Profile picture URL</Label>
          <Input id="webhook-picture" value={profileImageURL} onChange={(e) => setProfileImageURL(e.target.value)} placeholder="https://example.com/icon.png" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={lockToChannel} onChange={(e) => setLockToChannel(e.target.checked)} />
        Lock to this channel
      </label>

      <Button onClick={submit} disabled={create.isPending || !title.trim() || !selectedChannelID}>
        {create.isPending ? 'Creating...' : 'Create webhook'}
      </Button>

      {create.isError && (
        <p className="text-sm text-destructive" role="alert">
          {create.error instanceof Error ? create.error.message : 'Create failed'}
        </p>
      )}

      <div className="space-y-2">
        {webhooks.map((wh) => (
          <div key={wh.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{wh.title}</p>
              <p className="truncate text-xs text-muted-foreground">{wh.url}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => remove.mutate(wh.id)}>
              Delete
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
