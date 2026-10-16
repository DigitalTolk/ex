import { lazy, Suspense, useState } from 'react';
import { Eye } from 'lucide-react';
import type { HtmlPreviewTarget } from './HtmlPreviewPanel';

// The panel (dialog + sandboxed frame) is its own chunk: the message list
// only ever carries this button.
const HtmlPreviewPanel = lazy(() => import('./HtmlPreviewPanel'));

interface HtmlPreviewButtonProps {
  attachment: HtmlPreviewTarget;
  className?: string;
  iconClassName?: string;
}

// HtmlPreviewButton is the "Preview" action beside an HTML attachment's
// download link. Callers render it only for canPreviewHtml() attachments, so
// other rows pay nothing; this one holds a single open flag and mounts the
// panel on demand — never in the list itself, only on an explicit click.
export function HtmlPreviewButton({ attachment, className, iconClassName }: HtmlPreviewButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Preview ${attachment.filename}`}
        title="Preview"
        data-testid="html-preview-open"
        className={className}
      >
        <Eye className={iconClassName} aria-hidden />
      </button>
      {open && (
        <Suspense fallback={null}>
          <HtmlPreviewPanel attachment={attachment} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
