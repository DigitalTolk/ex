import { useMemo, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAllUsers } from '@/hooks/useConversations';
import { useApproveHeldRemoval, useSetUserGroupEnabled, useUserGroup } from '@/hooks/useUserGroups';
import { errorMessage } from '@/lib/error-message';
import { getInitials } from '@/lib/format';
import type { UserGroupDetail } from '@/types/generated';
import { UserGroupEditDialog } from './UserGroupEditDialog';

interface Props {
  groupId: string;
  canManage: boolean;
  onClose: () => void;
}

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

// sourceText says where a group's members come from.
function sourceText(g: UserGroupDetail): string {
  return g.source.kind === 'squad' ? `Squad ${g.source.squad} in ${g.source.department}` : `Department ${g.source.department}`;
}

// heldText explains a removal the sync holds for an admin, or "" when none.
function heldText(g: UserGroupDetail): string {
  const what = g.source.kind === 'squad' ? 'squad' : 'department';
  if (g.syncState === 'source-missing') {
    return g.pendingRemoval
      ? `No one in Microsoft 365 is in this ${what} any more. Its ${people(g.pendingRemoval)} stay until an admin approves removing them, or disables the group.`
      : `No one in Microsoft 365 is in this ${what} any more.`;
  }
  if (g.syncState === 'held-removal') {
    // A held removal always counts who would be removed.
    return `${people(g.pendingRemoval!)} left this ${what} in Microsoft 365. Removing them waits for an admin.`;
  }
  return '';
}

// UserGroupDetailDialog shows one group: its handle, name, description, the
// Microsoft 365 department or squad it follows, and its members. Admins edit
// its details, disable or enable it, and approve a removal the sync holds.
export function UserGroupDetailDialog({ groupId, canManage, onClose }: Props) {
  const { data: group, isLoading } = useUserGroup(groupId);
  const { data: users = [] } = useAllUsers();
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const [editing, setEditing] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [error, setError] = useState('');
  const setEnabled = useSetUserGroupEnabled();
  const approve = useApproveHeldRemoval();

  const onError = (e: unknown) => setError(errorMessage(e, 'Saving failed'));

  if (editing && group) {
    return <UserGroupEditDialog group={group} onClose={() => setEditing(false)} />;
  }

  const members = group?.memberIds ?? [];
  const held = group ? heldText(group) : '';
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
                <div className="mt-2 space-y-0.5 text-sm text-muted-foreground" data-testid="usergroup-source">
                  <p>
                    <Badge variant="secondary">Microsoft 365</Badge> {sourceText(group)}
                  </p>
                  {!!group.syncSkipped && (
                    <p>
                      {people(group.syncSkipped)} in this {group.source.kind === 'squad' ? 'squad' : 'department'}{' '}
                      {group.syncSkipped === 1 ? "isn't" : "aren't"} in ex yet.
                    </p>
                  )}
                </div>
              </div>

              {held && (
                <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
                  <p>{held}</p>
                  {group.removalApproved ? (
                    <p className="text-muted-foreground">Removal approved: it happens at the next sync, within 30 minutes.</p>
                  ) : (
                    canManage &&
                    !!group.pendingRemoval && (
                      <Button size="sm" onClick={() => approve.mutate(group.id, { onError })} disabled={approve.isPending}>
                        Approve removal
                      </Button>
                    )
                  )}
                </div>
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
            // The actions wrap rather than widen the dialog.
            <DialogFooter className="sm:flex-wrap">
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
