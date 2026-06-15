import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBrowseChannels, useUserChannels } from '@/hooks/useChannels';
import { useCreateIncomingWebhook, useDeleteIncomingWebhook, useIncomingWebhooks } from '@/hooks/useWebhooks';
import { copyToClipboard } from '@/lib/clipboard';

export function IncomingWebhooksPanel() {
  const { data: memberships = [] } = useUserChannels();
  const { data: publicChannels = [] } = useBrowseChannels();
  const { data: webhooks = [] } = useIncomingWebhooks();
  const create = useCreateIncomingWebhook();
  const remove = useDeleteIncomingWebhook();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [channelID, setChannelID] = useState('');
  const [lockToChannel, setLockToChannel] = useState(true);
  const [username, setUsername] = useState('');
  const [profileImageURL, setProfileImageURL] = useState('');
  const [copiedID, setCopiedID] = useState('');

  // Webhooks may target any public channel plus any private channel the
  // creator belongs to — mirror that by merging the public directory with
  // the admin's own memberships (deduped by channel id).
  const channelOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const ch of publicChannels) map.set(ch.id, { id: ch.id, name: ch.name });
    for (const m of memberships) {
      if (!map.has(m.channelID)) map.set(m.channelID, { id: m.channelID, name: m.channelName });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [publicChannels, memberships]);

  const selectedChannelID = channelID || channelOptions[0]?.id || '';

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

  async function copyURL(id: string, url: string) {
    await copyToClipboard(url);
    setCopiedID(id);
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
            {channelOptions.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name}
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
          <div key={wh.id} className="space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{wh.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span>~{wh.channelSlug || wh.channelName || wh.channelID}</span>
                  <span aria-hidden>·</span>
                  <span>{wh.lockToChannel ? 'Locked to channel' : 'Channel override allowed'}</span>
                  <span aria-hidden>·</span>
                  <span>as {wh.username || 'webhook'}</span>
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => remove.mutate(wh.id)}>
                Delete
              </Button>
            </div>
            {wh.url && (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{wh.url}</code>
                <Button variant="outline" size="sm" onClick={() => copyURL(wh.id, wh.url!)}>
                  {copiedID === wh.id ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
