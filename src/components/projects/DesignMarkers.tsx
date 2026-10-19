import { useState } from 'react';
import { Check, Columns2, Lightbulb, SplitSquareHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  ImageComparison,
  ImageComparisonHandle,
  ImageComparisonImage,
  ImageComparisonLabel,
} from '@/components/ui/image-comparison';
import { useAttachmentsBatch, type AttachmentAccessContext } from '@/hooks/useAttachments';
import { useProject, useUpdateProject } from '@/hooks/useProjects';
import { appendDesignNote, noteSaved, parseDesignMarkers } from '@/lib/design-markers';
import { showToast } from '@/lib/toast';

// DesignMarkers renders what Apelles' hidden markers ask for under its post:
// a before/after slider against the real page it copied, and one-click
// suggestions to add a learned rule to the project's design notes. Mounted
// only for messages that carry markers (see hasDesignMarkers).

export function DesignMarkers({
  body,
  attachmentIDs = [],
  channelId,
  conversationId,
  messageID,
}: {
  body: string;
  attachmentIDs?: string[];
  channelId?: string;
  conversationId?: string;
  messageID: string;
}) {
  const { before, notes } = parseDesignMarkers(body);
  if (!before && notes.length === 0) return null;
  // The same access context the message's own attachment list uses.
  const access: AttachmentAccessContext = {
    parentID: channelId ?? conversationId,
    parentType: channelId ? 'channel' : conversationId ? 'conversation' : undefined,
    messageID,
  };
  return (
    <div className="mt-1.5 flex flex-col gap-1.5" data-testid="design-markers">
      {before && (
        <CompareButton
          project={before.project}
          referenceID={before.attachmentID}
          attachmentIDs={attachmentIDs}
          access={access}
        />
      )}
      {notes.map((n) => (
        <NoteSuggestion key={n.project + n.text} project={n.project} text={n.text} />
      ))}
    </div>
  );
}

function CompareButton({
  project,
  referenceID,
  attachmentIDs,
  access,
}: {
  project: string;
  referenceID: string;
  attachmentIDs: string[];
  access: AttachmentAccessContext;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
        <Columns2 aria-hidden="true" />
        Compare with the real page
      </Button>
      {open && (
        <CompareDialog
          project={project}
          referenceID={referenceID}
          attachmentIDs={attachmentIDs}
          access={access}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CompareDialog({
  project,
  referenceID,
  attachmentIDs,
  access,
  onClose,
}: {
  project: string;
  referenceID: string;
  attachmentIDs: string[];
  access: AttachmentAccessContext;
  onClose: () => void;
}) {
  const { data: detail } = useProject(project);
  const { map } = useAttachmentsBatch(attachmentIDs, access);
  const [mode, setMode] = useState<'slide' | 'side'>('slide');
  const reference = detail?.screens.find((s) => s.attachmentID === referenceID);
  const mockup = attachmentIDs.map((id) => map.get(id)).find((a) => a?.contentType.startsWith('image/') && a.url);
  const ready = !!reference?.imageURL && !!mockup?.url;
  // The stage takes the mockup's own proportions, so it shows whole.
  const [rw, rh] = mockup?.width && mockup.height ? [mockup.width, mockup.height] : [16, 10];
  const aspectRatio = `${rw} / ${rh}`;
  // As wide as the dialog allows, but never taller than the window: the whole
  // comparison stays in view without scrolling.
  const stageWidth = `min(100%, calc((100dvh - 11rem) * ${rw} / ${rh}))`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="full" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Real page vs mockup</DialogTitle>
        </DialogHeader>
        {!ready ? (
          <p className="text-sm text-muted-foreground" data-testid="compare-loading">
            {detail && !reference ? 'The reference screen is no longer on the project.' : 'Loading both images…'}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {mode === 'slide' ? 'Drag the divider, or focus it and use the arrow keys.' : 'The real page and the mockup side by side.'}
              </p>
              <div role="group" aria-label="Compare view" className="flex rounded-lg border p-0.5">
                {(
                  [
                    ['slide', 'Slide', SplitSquareHorizontal],
                    ['side', 'Side by side', Columns2],
                  ] as const
                ).map(([m, label, Icon]) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                      mode === m ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {mode === 'slide' ? (
              <ImageComparison aria-label="Real page and mockup divider" style={{ aspectRatio, width: stageWidth }} className="mx-auto">
                <ImageComparisonImage side="after" src={mockup!.url!} alt="Mockup" />
                <ImageComparisonImage side="before" src={reference!.imageURL!} alt="Real page" />
                <ImageComparisonLabel side="before">Real page</ImageComparisonLabel>
                <ImageComparisonLabel side="after">Mockup</ImageComparisonLabel>
                <ImageComparisonHandle />
              </ImageComparison>
            ) : (
              <div className="grid grid-cols-2 gap-2" data-testid="compare-side-by-side">
                {(
                  [
                    ['Real page', reference!.imageURL!],
                    ['Mockup', mockup!.url!],
                  ] as const
                ).map(([caption, src]) => (
                  <figure key={caption} className="space-y-1">
                    <img
                      src={src}
                      alt={caption}
                      className="h-auto max-h-[calc(100dvh-11rem)] w-full rounded-md border object-contain object-top"
                    />
                    <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NoteSuggestion({ project, text }: { project: string; text: string }) {
  const { data: detail } = useProject(project);
  const update = useUpdateProject(project);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const notes = detail?.project.designNotes ?? '';
  const saved = noteSaved(notes, text);
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-card p-2 text-sm" data-testid="design-note-suggestion">
      <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          Suggested design note{detail ? ` for ${detail.project.name}` : ''}
        </p>
        <p>{text}</p>
      </div>
      {saved ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          In design notes
        </span>
      ) : (
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            disabled={!detail || update.isPending}
            onClick={() =>
              update.mutate(
                { designNotes: appendDesignNote(notes, text) },
                {
                  onSuccess: () => showToast('Added to design notes', 'success'),
                  onError: (e) => showToast(e instanceof Error ? e.message : 'Could not save the note'),
                },
              )
            }
          >
            Add to design notes
          </Button>
          <Button size="sm" variant="ghost" aria-label="Dismiss suggestion" onClick={() => setDismissed(true)}>
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
