import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FileTypeIcon } from './FileTypeIcon';

function tile(props: { name: string; mimeType?: string; folder?: boolean }) {
  const { container } = render(<FileTypeIcon {...props} className="h-12 w-12" iconClassName="h-6 w-6" />);
  return container.querySelector('[data-testid="file-type-icon"]') as HTMLElement;
}

describe('FileTypeIcon', () => {
  it('gives documents, spreadsheets, presentations and PDFs their own tile', () => {
    for (const [name, kind, tone] of [
      ['Plan.DOCX', 'document', 'bg-file-document'],
      ['notes.rtf', 'document', 'bg-file-document'],
      ['Budget.xlsx', 'spreadsheet', 'bg-file-spreadsheet'],
      ['export.csv', 'spreadsheet', 'bg-file-spreadsheet'],
      ['Pitch.pptx', 'presentation', 'bg-file-presentation'],
      ['Scan.pdf', 'pdf', 'bg-file-pdf'],
    ]) {
      const el = tile({ name });
      expect(el).toHaveAttribute('data-kind', kind);
      expect(el).toHaveClass(tone, 'text-file-foreground', 'h-12', 'w-12');
      expect(el).toHaveAttribute('aria-hidden', 'true');
      expect(el.querySelector('svg')).toHaveClass('h-6', 'w-6');
    }
  });

  it('keeps the plain glyph on the muted tile for anything else, and a folder', () => {
    for (const props of [{ name: 'photo.png', mimeType: 'image/png' }, { name: 'notes' }, { name: 'Reports.docx', folder: true }]) {
      const el = tile(props);
      expect(el).toHaveAttribute('data-kind', 'other');
      expect(el).toHaveClass('bg-muted', 'text-muted-foreground');
    }
    expect(tile({ name: 'photo.png', mimeType: 'image/png' }).querySelector('svg')).toHaveClass('lucide-file-image');
    expect(tile({ name: 'Reports.docx', folder: true }).querySelector('svg')).toHaveClass('lucide-folder');
  });
});
