import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLinkPreview, useLinkUserGroup } from '@/hooks/useUserGroups';
import { errorMessage } from '@/lib/error-message';
import { linkSummary } from '@/lib/user-groups';
import type { EntraGroup } from '@/types/generated';
import { EntraGroupPicker } from './EntraGroupPicker';

interface Props {
  groupId: string;
  handle: string;
  onClose: () => void;
}

// UserGroupLinkDialog points a group at another Microsoft 365 group: pick the
// group, see who would be added and removed, confirm.
export function UserGroupLinkDialog({ groupId, handle, onClose }: Props) {
  const [entraGroup, setEntraGroup] = useState<EntraGroup | null>(null);
  const [error, setError] = useState('');
  const { data: preview } = useLinkPreview(entraGroup?.id, groupId);
  const link = useLinkUserGroup();
  const canLink = !!entraGroup && !!preview && !link.isPending;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent size="md" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Change the Microsoft 365 group of @{handle}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Its members will come from the Microsoft 365 group you choose and stay in sync with it.
          </p>
          <EntraGroupPicker value={entraGroup} onChange={setEntraGroup} />
          {preview && (
            <p className="text-sm text-muted-foreground" data-testid="link-summary">
              {linkSummary(preview)}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={link.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!canLink}
            onClick={() =>
              link.mutate(
                { id: groupId, entraGroupId: entraGroup!.id },
                { onSuccess: onClose, onError: (e) => setError(errorMessage(e, 'Changing the group failed')) },
              )
            }
          >
            {link.isPending ? 'Changing…' : 'Change group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
