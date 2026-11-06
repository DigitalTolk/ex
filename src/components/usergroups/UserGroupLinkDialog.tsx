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

// UserGroupLinkDialog links an existing group to a Microsoft 365 group: pick
// the group, see who would be added and removed, confirm.
export function UserGroupLinkDialog({ groupId, handle, onClose }: Props) {
  const [entraGroup, setEntraGroup] = useState<EntraGroup | null>(null);
  const [error, setError] = useState('');
  const { data: preview } = useLinkPreview(entraGroup?.id, groupId);
  const link = useLinkUserGroup();
  const canLink = !!entraGroup && !!preview && !preview.overLimit && !link.isPending;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent size="md" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Link @{handle} to Microsoft 365</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Its members will come from the Microsoft 365 group and stay in sync. You can unlink it later and keep them.
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
                { onSuccess: onClose, onError: (e) => setError(errorMessage(e, 'Linking failed')) },
              )
            }
          >
            {link.isPending ? 'Linking…' : 'Link group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
