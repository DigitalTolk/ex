import { useState } from 'react';
import { Download, FileText, Images } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatBytes } from '@/lib/format';
import { canPreviewHtml } from '@/lib/html-attachment';
import type { RunFile } from '@/lib/run-timeline';
import { HtmlPreviewButton } from './HtmlPreviewButton';

// RunFiles is the Activity Drawer's answer to "what did it look at, and what
// did it make?": the files a run was given, the ones it fetched (thread files
// and project reference screenshots) and the ones it posted. Images show as
// thumbnails that open full size; other files get download (and Preview for
// HTML mockups).

const GROUPS: { role: RunFile['role']; label: string }[] = [
  { role: 'given', label: 'Given to it' },
  { role: 'fetched', label: 'Looked at' },
  { role: 'posted', label: 'Posted' },
];

const isImage = (f: RunFile) => f.contentType.startsWith('image/');

function sourceLabel(f: RunFile): string {
  if (f.role === 'fetched') return f.source === 'project_screen' ? 'Project reference screen' : 'From the thread';
  return f.role === 'given' ? 'Attached to the request' : 'Posted by the agent';
}

export function RunFiles({ files }: { files: RunFile[] }) {
  const [viewing, setViewing] = useState<RunFile | null>(null);
  if (files.length === 0) return null;
  return (
    <div className="mb-3" data-testid="run-files">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Images className="h-3.5 w-3.5" aria-hidden="true" />
        Files
      </div>
      <div className="space-y-2.5 rounded-lg border p-2.5">
        {GROUPS.map(({ role, label }) => {
          const group = files.filter((f) => f.role === role);
          if (group.length === 0) return null;
          const images = group.filter(isImage);
          const others = group.filter((f) => !isImage(f));
          return (
            <section key={role} aria-label={label}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                {label} ({group.length})
              </h3>
              {images.length > 0 && (
                <div className="mb-1.5 grid grid-cols-3 gap-1.5">
                  {images.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setViewing(f)}
                      title={`${f.filename} — ${sourceLabel(f)}`}
                      aria-label={`View ${f.filename}`}
                      className="overflow-hidden rounded-md border bg-muted hover:ring-2 hover:ring-ring/40"
                    >
                      {f.thumbnailURL || f.url ? (
                        <img
                          src={f.thumbnailURL || f.url}
                          alt=""
                          width={120}
                          height={75}
                          loading="lazy"
                          className="aspect-[16/10] h-auto w-full object-cover object-top"
                        />
                      ) : (
                        <span className="flex aspect-[16/10] items-center justify-center text-xs text-muted-foreground">
                          {f.filename}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {others.map((f) => (
                <div key={f.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-xs">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate" title={f.filename}>
                    {f.filename}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{formatBytes(f.size)}</span>
                  {canPreviewHtml(f) && (
                    <HtmlPreviewButton
                      attachment={f}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      iconClassName="h-3.5 w-3.5"
                    />
                  )}
                  {(f.downloadURL || f.url) && (
                    <a
                      href={f.downloadURL || f.url}
                      download={f.filename}
                      aria-label={`Download ${f.filename}`}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent size="full" finalFocus={false}>
          <DialogHeader>
            <DialogTitle>{viewing?.filename}</DialogTitle>
          </DialogHeader>
          {viewing && (
            <>
              <p className="text-xs text-muted-foreground">{sourceLabel(viewing)}</p>
              {viewing.url && (
                <img
                  src={viewing.url}
                  alt={viewing.filename}
                  width={viewing.width || undefined}
                  height={viewing.height || undefined}
                  className="mx-auto h-auto max-h-[calc(100dvh-9rem)] w-auto max-w-full rounded-md object-contain"
                />
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
