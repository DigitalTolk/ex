import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { checkUserGroupHandle, useUpdateUserGroup } from '@/hooks/useUserGroups';
import {
  MAX_USER_GROUP_DESCRIPTION_CHARS,
  MAX_USER_GROUP_NAME_CHARS,
  countCodepoints,
  isValidUserGroupHandle,
} from '@/lib/limits';
import { errorMessage } from '@/lib/error-message';
import { queryKeys } from '@/lib/query-keys';
import type { UserGroupDetail } from '@/types/generated';

interface Props {
  group: UserGroupDetail;
  onClose: () => void;
}


// UserGroupEditDialog edits a group's handle, name and description. Once an
// admin saves, the sync keeps these as set instead of following Microsoft 365.
export function UserGroupEditDialog({ group, onClose }: Props) {
  const [name, setName] = useState(group.name);
  const [handle, setHandle] = useState(group.handle);
  const [description, setDescription] = useState(group.description);
  const [error, setError] = useState('');
  const update = useUpdateUserGroup();
  const debouncedHandle = useDebouncedValue(handle, 300);

  // Is the (debounced) handle free? Asked only for a well-formed handle that
  // isn't the group's own; one query per handle, so a late answer for an
  // earlier handle can't overwrite the current one. A failed check says
  // nothing: the server decides on save anyway.
  const unchanged = !debouncedHandle || debouncedHandle === group.handle;
  const wellFormed = isValidUserGroupHandle(debouncedHandle);
  const availability = useQuery({
    queryKey: queryKeys.userGroupHandle(debouncedHandle),
    queryFn: () => checkUserGroupHandle(debouncedHandle),
    enabled: !unchanged && wellFormed,
    staleTime: 10_000,
  });
  const taken = !unchanged && wellFormed && availability.data === false;

  const nameOk = name.trim() !== '' && countCodepoints(name.trim()) <= MAX_USER_GROUP_NAME_CHARS;
  const descOk = countCodepoints(description.trim()) <= MAX_USER_GROUP_DESCRIPTION_CHARS;
  const handleOk = isValidUserGroupHandle(handle) && !taken;
  const canSave = nameOk && descOk && handleOk && !update.isPending;

  const save = () => {
    setError('');
    update.mutate(
      { id: group.id, patch: { handle, name: name.trim(), description: description.trim() } },
      { onSuccess: onClose, onError: (e: unknown) => setError(errorMessage(e, 'Saving failed')) },
    );
  };

  let handleHint = '';
  if (!isValidUserGroupHandle(handle)) {
    handleHint = "2 to 30 lowercase letters, digits, '.', '-' or '_', starting with a letter or digit.";
  } else if (taken) {
    handleHint = `@${handle} is taken.`;
  } else if (handle !== group.handle) {
    handleHint = `Messages that already mention @${group.handle} will show @${handle}.`;
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent size="md" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Edit user group</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Members always come from Microsoft 365. What you set here is kept as is.
          </p>
          <div className="space-y-2">
            <Label htmlFor="usergroup-name">Name</Label>
            <Input id="usergroup-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="usergroup-handle">Handle</Label>
            <Input
              id="usergroup-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/^@/, ''))}
              aria-describedby="usergroup-handle-hint"
            />
            <p id="usergroup-handle-hint" className="text-xs text-muted-foreground" aria-live="polite">
              {handleHint}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="usergroup-description">Description (optional)</Label>
            <Input id="usergroup-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
