import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { checkUserGroupHandle, useCreateUserGroup, useLinkPreview, useUpdateUserGroup } from '@/hooks/useUserGroups';
import {
  MAX_USER_GROUP_DESCRIPTION_CHARS,
  MAX_USER_GROUP_NAME_CHARS,
  countCodepoints,
  isValidUserGroupHandle,
  suggestUserGroupHandle,
} from '@/lib/limits';
import { errorMessage } from '@/lib/error-message';
import { queryKeys } from '@/lib/query-keys';
import { linkSummary } from '@/lib/user-groups';
import type { EntraGroup, UserGroupDetail } from '@/types/generated';
import { EntraGroupPicker } from './EntraGroupPicker';
import { MemberPicker } from './MemberPicker';

interface Props {
  // The group to edit; absent → create a new one.
  group?: UserGroupDetail;
  // Offer creating the group from a Microsoft 365 group (admins, with the
  // integration configured).
  canLinkMicrosoft?: boolean;
  onClose: () => void;
  onSaved?: (group: UserGroupDetail) => void;
}

type HandleState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

function handleStateOf(unchanged: boolean, wellFormed: boolean, checking: boolean, available: boolean | undefined): HandleState {
  if (unchanged) return 'idle';
  if (!wellFormed) return 'invalid';
  if (checking) return 'checking';
  if (available === undefined) return 'idle';
  return available ? 'available' : 'taken';
}

// UserGroupFormDialog creates a user group (name, handle, description, then
// its members) or edits an existing group's details.
export function UserGroupFormDialog({ group, canLinkMicrosoft = false, onClose, onSaved }: Props) {
  const editing = !!group;
  const [source, setSource] = useState<'manual' | 'microsoft'>('manual');
  const [entraGroup, setEntraGroup] = useState<EntraGroup | null>(null);
  const fromMicrosoft = source === 'microsoft';
  const { data: preview } = useLinkPreview(fromMicrosoft ? entraGroup?.id : undefined);
  const [name, setName] = useState(group?.name ?? '');
  const [handle, setHandle] = useState(group?.handle ?? '');
  const [handleEdited, setHandleEdited] = useState(editing);
  const [description, setDescription] = useState(group?.description ?? '');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const create = useCreateUserGroup();
  const update = useUpdateUserGroup();
  const saving = create.isPending || update.isPending;

  const effectiveHandle = handleEdited ? handle : suggestUserGroupHandle(name);
  const debouncedHandle = useDebouncedValue(effectiveHandle, 300);

  // Is the (debounced) handle free? Asked only for a well-formed handle that
  // isn't the group's own; one query per handle, so a late answer for an
  // earlier handle can't overwrite the current one. A failed check says
  // nothing: the server decides on save anyway.
  const unchanged = !debouncedHandle || (editing && debouncedHandle === group?.handle);
  const wellFormed = isValidUserGroupHandle(debouncedHandle);
  const availability = useQuery({
    queryKey: queryKeys.userGroupHandle(debouncedHandle),
    queryFn: () => checkUserGroupHandle(debouncedHandle),
    enabled: !unchanged && wellFormed,
    staleTime: 10_000,
  });
  const handleState = handleStateOf(unchanged, wellFormed, availability.fetchStatus === 'fetching', availability.data);

  const nameOk = name.trim() !== '' && countCodepoints(name.trim()) <= MAX_USER_GROUP_NAME_CHARS;
  const descOk = countCodepoints(description.trim()) <= MAX_USER_GROUP_DESCRIPTION_CHARS;
  const handleOk = isValidUserGroupHandle(effectiveHandle) && handleState !== 'taken';
  const sourceOk = !fromMicrosoft || (!!preview && !preview.overLimit);
  const canSave = nameOk && descOk && handleOk && sourceOk && !saving;

  const save = () => {
    setError('');
    const onError = (e: unknown) => setError(errorMessage(e, 'Saving failed'));
    const onSuccess = (saved: UserGroupDetail) => {
      onSaved?.(saved);
      onClose();
    };
    if (group) {
      update.mutate(
        { id: group.id, patch: { handle: effectiveHandle, name: name.trim(), description: description.trim() } },
        { onSuccess, onError },
      );
      return;
    }
    create.mutate(
      fromMicrosoft
        ? { handle: effectiveHandle, name: name.trim(), description: description.trim(), memberIds: [], entraGroupId: entraGroup?.id }
        : { handle: effectiveHandle, name: name.trim(), description: description.trim(), memberIds },
      { onSuccess, onError },
    );
  };

  const handleHint: Record<HandleState, string> = {
    idle: '',
    checking: 'Checking…',
    available: `@${effectiveHandle} is available.`,
    taken: `@${effectiveHandle} is taken.`,
    invalid: "2 to 30 lowercase letters, digits, '.', '-' or '_', starting with a letter or digit.",
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent size="md" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit user group' : 'Create user group'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!editing && canLinkMicrosoft && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Members come from</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="usergroup-source" checked={!fromMicrosoft} onChange={() => setSource('manual')} />
                Added manually in ex
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="usergroup-source" checked={fromMicrosoft} onChange={() => setSource('microsoft')} />
                A Microsoft 365 group
              </label>
            </fieldset>
          )}
          {fromMicrosoft && (
            <div className="space-y-2">
              <EntraGroupPicker
                value={entraGroup}
                onChange={(g) => {
                  setEntraGroup(g);
                  if (name.trim() === '') setName(g.displayName);
                }}
              />
              {preview && (
                <p className="text-sm text-muted-foreground" data-testid="link-summary">
                  {linkSummary(preview)}
                </p>
              )}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="usergroup-name">Name</Label>
            <Input id="usergroup-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="On-call engineers" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="usergroup-handle">Handle</Label>
            <Input
              id="usergroup-handle"
              value={effectiveHandle}
              onChange={(e) => {
                setHandleEdited(true);
                setHandle(e.target.value.toLowerCase().replace(/^@/, ''));
              }}
              placeholder="oncall"
              aria-describedby="usergroup-handle-hint"
            />
            <p id="usergroup-handle-hint" className="text-xs text-muted-foreground" aria-live="polite">
              {editing && effectiveHandle !== group?.handle && handleState !== 'taken' && handleState !== 'invalid'
                ? `Messages that already mention @${group?.handle} will show @${effectiveHandle}.`
                : handleHint[handleState]}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="usergroup-description">Description (optional)</Label>
            <Input
              id="usergroup-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Who gets paged for production incidents"
            />
          </div>
          {!editing && !fromMicrosoft && (
            <div className="space-y-2">
              <Label>Members</Label>
              <MemberPicker selected={memberIds} onChange={setMemberIds} />
            </div>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Create group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
