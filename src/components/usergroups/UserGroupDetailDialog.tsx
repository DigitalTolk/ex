import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAllUsers } from '@/hooks/useConversations';
import {
  useAddUserGroupMembers,
  useRemoveUserGroupMember,
  useSetUserGroupEnabled,
  useSyncUserGroup,
  useUnlinkUserGroup,
  useUserGroup,
} from '@/hooks/useUserGroups';
import { errorMessage } from '@/lib/error-message';
import { formatRelative, getInitials } from '@/lib/format';
import { MAX_USER_GROUP_MEMBERS } from '@/lib/limits';
import { MemberPicker } from './MemberPicker';
import { UserGroupFormDialog } from './UserGroupFormDialog';
import { UserGroupLinkDialog } from './UserGroupLinkDialog';

interface Props {
  groupId: string;
  canManage: boolean;
  // Admins with the Microsoft 365 integration: link, unlink and sync.
  canLinkMicrosoft?: boolean;
  onClose: () => void;
}

const SYNC_STATE_TEXT: Record<string, string> = {
  'paused-oversize': `The Microsoft 365 group has more than ${MAX_USER_GROUP_MEMBERS} people, so syncing is paused. Members stay as last synced.`,
  'source-missing': "The Microsoft 365 group can't be found. Members stay as last synced; relink or unlink the group.",
  error: "Microsoft 365 couldn't be reached at the last sync. Members stay as last synced.",
};

// UserGroupDetailDialog shows one group — its handle, name, description and
// members — and, for managers, edits it: details, members, disable/enable.
export function UserGroupDetailDialog({ groupId, canManage, canLinkMicrosoft = false, onClose }: Props) {
  const { data: group, isLoading } = useUserGroup(groupId);
  const { data: users = [] } = useAllUsers();
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState<string[]>([]);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [error, setError] = useState('');
  const addMembers = useAddUserGroupMembers();
  const removeMember = useRemoveUserGroupMember();
  const setEnabled = useSetUserGroupEnabled();
  const sync = useSyncUserGroup();
  const unlink = useUnlinkUserGroup();
  const [linking, setLinking] = useState(false);

  const onError = (e: unknown) => setError(errorMessage(e, 'Saving failed'));

  if (editing && group) {
    return <UserGroupFormDialog group={group} onClose={() => setEditing(false)} />;
  }
  if (linking && group) {
    return <UserGroupLinkDialog groupId={group.id} handle={group.handle} onClose={() => setLinking(false)} />;
  }

  const members = group?.memberIds ?? [];
  const linked = !!group?.entraGroupId;
  // A linked group's members come from Microsoft 365.
  const editMembers = canManage && !linked;
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
                {linked && (
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

              {linked && group.syncState === 'held-removal' && (
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
              {linked && group.syncState && SYNC_STATE_TEXT[group.syncState] && (
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
                        {editMembers && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Remove ${name}`}
                            disabled={removeMember.isPending}
                            onClick={() => removeMember.mutate({ id: group.id, userId: id }, { onError })}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </li>
                    );
                  })}
                  {members.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No members yet.</li>}
                </ul>
              </div>

              {editMembers && adding && (
                <div className="space-y-2">
                  <MemberPicker selected={[...members, ...toAdd]} onChange={(ids) => setToAdd(ids.filter((id) => !members.includes(id)))} />
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setAdding(false); setToAdd([]); }}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={toAdd.length === 0 || addMembers.isPending}
                      onClick={() =>
                        addMembers.mutate(
                          { id: group.id, userIds: toAdd },
                          { onSuccess: () => { setAdding(false); setToAdd([]); }, onError },
                        )
                      }
                    >
                      Add {toAdd.length > 0 ? `(${toAdd.length})` : ''}
                    </Button>
                  </div>
                </div>
              )}

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
          {group && canManage && (
            <DialogFooter>
              {canLinkMicrosoft && linked && (
                <>
                  <Button variant="outline" onClick={() => unlink.mutate(groupId, { onError })} disabled={unlink.isPending}>
                    Unlink
                  </Button>
                  <Button variant="outline" onClick={() => syncNow(false)} disabled={sync.isPending}>
                    {sync.isPending ? 'Syncing…' : 'Sync now'}
                  </Button>
                </>
              )}
              {canLinkMicrosoft && !linked && (
                <Button variant="outline" onClick={() => setLinking(true)}>
                  Link to Microsoft 365 group
                </Button>
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
              {editMembers && !adding && <Button onClick={() => setAdding(true)}>Add members</Button>}
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
