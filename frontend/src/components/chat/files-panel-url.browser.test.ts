import { describe, expect, it } from 'vitest';
import { attachmentURLForFile } from './files-panel-url';

// Browser-gate coverage for the FilesPanel attachment URL builder (pure, no
// test previously). Exercises each optional query-param branch.

describe('attachmentURLForFile (browser)', () => {
  it('builds a fully-qualified URL with parent + message context', () => {
    const url = attachmentURLForFile(
      { attachmentID: 'att-1', messageID: 'msg-1' },
      'ch-1',
      'channel',
    );
    expect(url).toContain('/api/v1/attachments/att-1?');
    expect(url).toContain('parentID=ch-1');
    expect(url).toContain('parentType=channel');
    expect(url).toContain('messageID=msg-1');
  });

  it('returns a bare URL when no context or message id is provided', () => {
    const url = attachmentURLForFile(
      { attachmentID: 'att-2', messageID: '' },
      undefined,
      undefined,
    );
    expect(url).toBe('/api/v1/attachments/att-2');
  });

  it('includes only the parentType when that is the sole context', () => {
    const url = attachmentURLForFile(
      { attachmentID: 'att-3', messageID: '' },
      undefined,
      'conversation',
    );
    expect(url).toBe('/api/v1/attachments/att-3?parentType=conversation');
  });
});
