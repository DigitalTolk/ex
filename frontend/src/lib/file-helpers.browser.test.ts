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

  it('maps every extension switch case to its icon family', () => {
    // Each `case` label in the extension switch is its own branch in the
    // coverage view, so exercise the full set with a generic MIME so the
    // MIME if-chain falls through to the switch.
    const G = 'application/octet-stream';
    const doc = iconForAttachment(G, 'a.pdf');
    for (const n of ['a.doc', 'a.odt', 'a.rtf']) expect(iconForAttachment(G, n)).toBe(doc);
    const sheet = iconForAttachment(G, 'a.xls');
    for (const n of ['a.ods', 'a.csv', 'a.tsv']) expect(iconForAttachment(G, n)).toBe(sheet);
    const slide = iconForAttachment(G, 'a.ppt');
    for (const n of ['a.odp']) expect(iconForAttachment(G, n)).toBe(slide);
    const archive = iconForAttachment(G, 'a.zip');
    for (const n of ['a.rar', 'a.tar', 'a.gz']) expect(iconForAttachment(G, n)).toBe(archive);
    const video = iconForAttachment(G, 'a.mov');
    for (const n of ['a.avi', 'a.mkv', 'a.webm']) expect(iconForAttachment(G, n)).toBe(video);
    const audio = iconForAttachment(G, 'a.wav');
    for (const n of ['a.flac', 'a.ogg', 'a.m4a']) expect(iconForAttachment(G, n)).toBe(audio);
    const code = iconForAttachment(G, 'a.json');
    for (const n of ['a.xml', 'a.yaml', 'a.yml', 'a.js', 'a.jsx', 'a.go', 'a.py', 'a.rb', 'a.java', 'a.c', 'a.h', 'a.cpp', 'a.cs', 'a.rs', 'a.sh', 'a.md']) {
      expect(iconForAttachment(G, n)).toBe(code);
    }
  });

  it('exercises the MIME if-chain for every recognised family', () => {
    expect(iconForAttachment('image/png')).toBeDefined();
    expect(iconForAttachment('video/mp4')).toBeDefined();
    expect(iconForAttachment('audio/mpeg')).toBeDefined();
    expect(iconForAttachment('application/pdf')).toBeDefined();
    expect(iconForAttachment('application/msword')).toBeDefined();
    expect(iconForAttachment('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeDefined();
    expect(iconForAttachment('application/vnd.ms-excel')).toBeDefined();
    expect(iconForAttachment('text/csv')).toBeDefined();
    expect(iconForAttachment('application/vnd.ms-powerpoint')).toBeDefined();
    expect(iconForAttachment('application/zip')).toBeDefined();
    expect(iconForAttachment('application/x-rar')).toBeDefined();
    expect(iconForAttachment('application/x-tar')).toBeDefined();
    expect(iconForAttachment('application/gzip')).toBeDefined();
    expect(iconForAttachment('application/x-7z-compressed')).toBeDefined();
    expect(iconForAttachment('text/plain')).toBeDefined();
    expect(iconForAttachment('application/json')).toBeDefined();
    expect(iconForAttachment('application/xml')).toBeDefined();
  });
});
