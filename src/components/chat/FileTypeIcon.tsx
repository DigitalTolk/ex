import { createElement } from 'react';
import { FileSpreadsheet, FileText, Folder, Presentation, type LucideIcon } from 'lucide-react';
import { iconForAttachment } from '@/lib/file-helpers';
import { cn } from '@/lib/utils';

type FileKind = 'document' | 'spreadsheet' | 'presentation' | 'pdf';

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  doc: 'document', docx: 'document', docm: 'document', dot: 'document', dotx: 'document', dotm: 'document',
  odt: 'document', rtf: 'document',
  xls: 'spreadsheet', xlsx: 'spreadsheet', xlsm: 'spreadsheet', xlsb: 'spreadsheet', ods: 'spreadsheet',
  csv: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', pptm: 'presentation', pps: 'presentation', ppsx: 'presentation',
  odp: 'presentation',
  pdf: 'pdf',
};

const KIND_LOOK: Record<FileKind, { icon: LucideIcon; tile: string }> = {
  document: { icon: FileText, tile: 'bg-file-document text-file-foreground' },
  spreadsheet: { icon: FileSpreadsheet, tile: 'bg-file-spreadsheet text-file-foreground' },
  presentation: { icon: Presentation, tile: 'bg-file-presentation text-file-foreground' },
  pdf: { icon: FileText, tile: 'bg-file-pdf text-file-foreground' },
};

interface FileTypeIconProps {
  name: string;
  mimeType?: string;
  folder?: boolean;
  // The tile's size and shape (e.g. "h-12 w-12 rounded-md").
  className: string;
  iconClassName: string;
}

// FileTypeIcon is a file's type as a tile: documents, spreadsheets,
// presentations and PDFs each on their own colour, anything else (and a
// folder) the plain glyph on the muted tile.
export function FileTypeIcon({ name, mimeType, folder, className, iconClassName }: FileTypeIconProps) {
  const ext = name.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? '';
  const kind = folder ? undefined : KIND_BY_EXTENSION[ext];
  const look = kind
    ? KIND_LOOK[kind]
    : { icon: folder ? Folder : iconForAttachment(mimeType ?? '', name), tile: 'bg-muted text-muted-foreground' };
  return (
    <span
      aria-hidden="true"
      data-testid="file-type-icon"
      data-kind={kind ?? 'other'}
      className={cn('flex shrink-0 items-center justify-center', look.tile, className)}
    >
      {createElement(look.icon, { className: iconClassName })}
    </span>
  );
}
