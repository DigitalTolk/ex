import { useMemo, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAllUsers } from '@/hooks/useConversations';
import { useSetUserGroupEnabled, useSyncUserGroup, useUserGroup } from '@/hooks/useUserGroups';
import { errorMessage } from '@/lib/error-message';
import { formatRelative, getInitials } from '@/lib/format';
import { UserGroupFormDialog } from './UserGroupFormDialog';
import { UserGroupLinkDialog } from './UserGroupLinkDialog';

interface Props {
  groupId: string;
  canManage: boolean;
  // Admins with the Microsoft 365 integration: change the group's Microsoft
  // 365 group and sync it.
  canLinkMicrosoft: boolean;
  onClose: () => void;
}

const SYNC_STATE_TEXT: Record<string, string> = {
  'source-missing': "The Microsoft 365 group can't be found. Members stay as last synced; choose another Microsoft 365 group or disable this one.",
  error: "Microsoft 365 couldn't be reached at the last sync. Members stay as last synced.",
};

// UserGroupDetailDialog shows one group — its handle, name, description, its
// Microsoft 365 group and members — and, for managers, edits it: details,
// disable/enable, and (with the integration) its Microsoft 365 group.
export function UserGroupDetailDialog({ groupId, canManage, canLinkMicrosoft, onClose }: Props) {
  const { data: group, isLoading } = useUserGroup(groupId);
  const { data: users = [] } = useAllUsers();
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const [editing, setEditing] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [error, setError] = useState('');
  const setEnabled = useSetUserGroupEnabled();
  const sync = useSyncUserGroup();
  const [linking, setLinking] = useState(false);

  const onError = (e: unknown) => setError(errorMessage(e, 'Saving failed'));

  if (editing && group) {
    return <UserGroupFormDialog group={group} onClose={() => setEditing(false)} />;
  }
  if (linking && group) {
    return <UserGroupLinkDialog groupId={group.id} handle={group.handle} onClose={() => setLinking(false)} />;
  }

  const members = group?.memberIds ?? [];
  const syncNow = (applyRemovals: boolean) => sync.mutate({ id: groupId, applyRemovals }, { onError });
  return (
    <>
      <Dialog open onOpenChange={onClose}>
        <DialogContent size="md" finalFocus={false}>
          <DialogHeader>
            <DialogTitle>{group ? `@${group.handle}` : 'User group'}</DialogTitle>
          </DialogHeader>
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && !group && <p className="text-sm text-muted-foreground">This group no longer exists.</p>}
          {group && (
            <div className="space-y-4" data-testid="usergroup-detail">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold">
                  {group.name}
                  {group.disabled && <Badge variant="secondary">Disabled</Badge>}
                </p>
                {group.description && <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>}
                {group.entraGroupId && (
                  <div className="mt-2 space-y-0.5 text-sm text-muted-foreground" data-testid="usergroup-linked">
                    <p>
                      <Badge variant="secondary">Microsoft 365</Badge> Managed in Microsoft 365 · {group.entraGroupName}
                    </p>
                    {group.syncedAt && <p>Last synced {formatRelative(group.syncedAt)}</p>}
                    {!!group.syncSkipped && (
                      <p>
                        {group.syncSkipped} {group.syncSkipped === 1 ? "person in the Microsoft 365 group isn't" : "people in the Microsoft 365 group aren't"} in ex
                        yet.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {group.syncState === 'held-removal' && (
                <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
                  <p>
                    Sync needs review: {group.pendingRemoval} {group.pendingRemoval === 1 ? 'person' : 'people'} would be removed.
                  </p>
                  {canLinkMicrosoft && (
                    <Button size="sm" onClick={() => syncNow(true)} disabled={sync.isPending}>
                      Apply
                    </Button>
                  )}
                </div>
              )}
              {group.syncState && SYNC_STATE_TEXT[group.syncState] && (
                <p role="status" className="rounded-md border p-3 text-sm">
                  {SYNC_STATE_TEXT[group.syncState]}
                </p>
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {members.length} {members.length === 1 ? 'member' : 'members'}
                </p>
                <ul className="max-h-64 space-y-1 overflow-y-auto" aria-label="Members">
                  {members.map((id) => {
                    const u = byId.get(id);
                    const name = u?.displayName ?? id;
                    return (
                      <li key={id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                        <Avatar className="h-6 w-6">
                          {u?.avatarURL && <AvatarImage src={u.avatarURL} alt="" />}
                          <AvatarFallback className="bg-primary/10 text-xs">{getInitials(name)}</AvatarFallback>
                        </Avatar>
                        <span className={`min-w-0 flex-1 truncate text-sm ${u?.status === 'deactivated' ? 'opacity-50' : ''}`}>
                          {name}
                        </span>
                      </li>
                    );
                  })}
                  {members.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No members yet.</li>}
                </ul>
              </div>

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
          {group && canManage && (
            <DialogFooter>
              {canLinkMicrosoft && (
                <>
                  <Button variant="outline" onClick={() => setLinking(true)}>
                    Change Microsoft 365 group
                  </Button>
                  <Button variant="outline" onClick={() => syncNow(false)} disabled={sync.isPending}>
                    {sync.isPending ? 'Syncing…' : 'Sync now'}
                  </Button>
                </>
              )}
              {group.disabled ? (
                <Button variant="outline" onClick={() => setEnabled.mutate({ id: group.id, enabled: true }, { onError })}>
                  Enable group
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setConfirmDisable(true)}>
                  Disable group
                </Button>
              )}
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit details
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
      {group && (
        <ConfirmDialog
          open={confirmDisable}
          onOpenChange={setConfirmDisable}
          title={`Disable @${group.handle}?`}
          description="Nobody can mention it while it's disabled. Its members stay, and you can enable it again."
          confirmLabel="Disable"
          destructive
          testIDPrefix="usergroup-disable"
          onConfirm={() => {
            setEnabled.mutate({ id: group.id, enabled: false }, { onError });
            setConfirmDisable(false);
          }}
        />
      )}
    </>
  );
}
