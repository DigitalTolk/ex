import { ArchiveRestore } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ArchivedChannelNoticeProps {
  /** Shown only to whoever may unarchive (owner or system admin). */
  onUnarchive?: () => void;
  unarchiving?: boolean;
}

// Stands in for the composer of an archived channel: its history stays
// readable, nobody can post until it is unarchived.
export function ArchivedChannelNotice({ onUnarchive, unarchiving }: ArchivedChannelNoticeProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground"
      role="status"
      data-testid="channel-archived-notice"
    >
      <span>This channel is archived. Its history is read-only.</span>
      {onUnarchive && (
        <Button size="sm" variant="outline" onClick={onUnarchive} disabled={unarchiving}>
          <ArchiveRestore className="mr-2 h-4 w-4" /> Unarchive
        </Button>
      )}
    </div>
  );
}
