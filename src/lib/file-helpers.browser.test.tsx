import { describe, expect, it } from 'vitest';
import {
  isImageURL,
  isImageContentType,
  isImageAttachment,
  iconForAttachment,
} from './file-helpers';

describe('file-helpers — image detection', () => {
  it('isImageURL returns true for known extensions with or without query strings', () => {
    expect(isImageURL('cat.png')).toBe(true);
    expect(isImageURL('cat.PNG')).toBe(true);
    expect(isImageURL('cat.jpg?v=1')).toBe(true);
    expect(isImageURL('cat.webp')).toBe(true);
    expect(isImageURL('cat.svg')).toBe(true);
    expect(isImageURL('spec.pdf')).toBe(false);
    expect(isImageURL('nope')).toBe(false);
  });

  it('isImageContentType matches the image/* family', () => {
    expect(isImageContentType('image/png')).toBe(true);
    expect(isImageContentType('IMAGE/jpeg')).toBe(true);
    expect(isImageContentType('application/pdf')).toBe(false);
  });

  it('isImageAttachment falls back to the filename when the MIME type is generic', () => {
    expect(isImageAttachment('application/octet-stream', 'photo.png')).toBe(true);
    expect(isImageAttachment('application/octet-stream', 'spec.pdf')).toBe(false);
    expect(isImageAttachment('image/jpeg')).toBe(true);
  });
});

describe('file-helpers — iconForAttachment branches', () => {
  it('returns distinct icons for the major MIME families', () => {
    const imageIcon = iconForAttachment('image/png');
    const videoIcon = iconForAttachment('video/mp4');
    const audioIcon = iconForAttachment('audio/mpeg');
    expect(imageIcon).not.toBe(videoIcon);
    expect(videoIcon).not.toBe(audioIcon);
  });

  it('maps each MIME family to a distinct Lucide icon', () => {
    expect(iconForAttachment('audio/mpeg')).toBe(iconForAttachment('audio/wav'));
    expect(iconForAttachment('application/pdf')).toBe(iconForAttachment('application/pdf'));
    expect(iconForAttachment('application/msword')).toBe(iconForAttachment('application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    expect(iconForAttachment('application/vnd.ms-excel')).toBe(iconForAttachment('text/csv'));
    expect(iconForAttachment('application/vnd.ms-powerpoint')).toBe(iconForAttachment('application/vnd.openxmlformats-officedocument.presentationml.presentation'));
    expect(iconForAttachment('application/zip')).toBe(iconForAttachment('application/x-7z-compressed'));
    expect(iconForAttachment('text/plain')).toBe(iconForAttachment('application/json'));
  });

  it('falls back to the filename extension when MIME is generic', () => {
    // Generic MIME → extension switch.
    expect(iconForAttachment('application/octet-stream', 'spec.pdf')).toBe(iconForAttachment('application/pdf'));
    expect(iconForAttachment('application/octet-stream', 'doc.docx')).toBe(iconForAttachment('application/msword'));
    expect(iconForAttachment('application/octet-stream', 'sheet.xlsx')).toBe(iconForAttachment('application/vnd.ms-excel'));
    expect(iconForAttachment('application/octet-stream', 'deck.pptx')).toBe(iconForAttachment('application/vnd.ms-powerpoint'));
    expect(iconForAttachment('application/octet-stream', 'archive.zip')).toBe(iconForAttachment('application/zip'));
    expect(iconForAttachment('application/octet-stream', 'clip.mp4')).toBe(iconForAttachment('video/mp4'));
    expect(iconForAttachment('application/octet-stream', 'song.mp3')).toBe(iconForAttachment('audio/mpeg'));
    expect(iconForAttachment('application/octet-stream', 'src.ts')).toBe(iconForAttachment('application/json'));
  });

  it('returns the generic File icon when nothing matches', () => {
    const generic = iconForAttachment('application/octet-stream', 'whatever.xyz');
    const text = iconForAttachment('text/plain');
    // Generic does not equal any of the specific icons.
    expect(generic).not.toBe(text);
  });
});
