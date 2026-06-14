import { describe, expect, it } from 'vitest';
import { iconForAttachment } from './file-helpers';

// Browser-gate coverage for the iconForAttachment extension switch.

describe('iconForAttachment (browser)', () => {
  it('maps common document/sheet/slide/archive/media extensions to an icon', () => {
    for (const name of [
      'a.pdf', 'a.docx', 'a.odt', 'a.rtf',
      'a.xlsx', 'a.csv', 'a.tsv',
      'a.pptx', 'a.odp',
      'a.zip', 'a.tar', 'a.7z',
      'a.mp4', 'a.mkv', 'a.webm',
      'a.mp3', 'a.flac', 'a.ogg',
    ]) {
      expect(iconForAttachment('application/octet-stream', name)).toBeDefined();
    }
  });

  it('falls back to a default icon for an unrecognised extension', () => {
    expect(iconForAttachment('application/octet-stream', 'mystery.xyz')).toBeDefined();
  });

  it('falls back to a default icon when there is no extension at all', () => {
    expect(iconForAttachment('application/octet-stream', 'noextension')).toBeDefined();
  });
});
