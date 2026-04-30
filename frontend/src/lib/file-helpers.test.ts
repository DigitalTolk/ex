import { describe, it, expect } from 'vitest';
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from 'lucide-react';
import { isImageURL, isImageContentType, iconForAttachment } from './file-helpers';

describe('isImageURL', () => {
  it.each([
    ['photo.png', true],
    ['photo.JPG', true],
    ['x.jpeg', true],
    ['x.gif', true],
    ['x.webp', true],
    ['x.bmp', true],
    ['x.svg', true],
    ['x.png?token=abc', true],
    ['document.pdf', false],
    ['archive.zip', false],
    ['x.txt', false],
    ['no-extension', false],
  ])('%s → %s', (input, expected) => {
    expect(isImageURL(input)).toBe(expected);
  });
});

describe('isImageContentType', () => {
  it.each([
    ['image/png', true],
    ['image/jpeg', true],
    ['IMAGE/PNG', true],
    ['application/pdf', false],
    ['text/plain', false],
    ['', false],
  ])('%s → %s', (input, expected) => {
    expect(isImageContentType(input)).toBe(expected);
  });
});

describe('iconForAttachment - by content type', () => {
  it.each([
    ['image/png', '', FileImage],
    ['image/jpeg', '', FileImage],
    ['video/mp4', '', FileVideo],
    ['audio/mp3', '', FileAudio],
    ['application/pdf', '', FileText],
    ['application/msword', '', FileText],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '', FileText],
    ['application/vnd.ms-excel', '', FileSpreadsheet],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '', FileSpreadsheet],
    ['text/csv', '', FileSpreadsheet],
    ['application/vnd.ms-powerpoint', '', FileImage],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '', FileImage],
    ['application/zip', '', FileArchive],
    ['application/x-rar', '', FileArchive],
    ['application/x-tar', '', FileArchive],
    ['application/gzip', '', FileArchive],
    ['application/x-7z-compressed', '', FileArchive],
    ['text/plain', '', FileCode],
    ['application/json', '', FileCode],
    ['application/xml', '', FileCode],
  ])('%s → expected icon', (ct, fn, expected) => {
    expect(iconForAttachment(ct, fn)).toBe(expected);
  });
});

describe('iconForAttachment - by extension fallback (octet-stream)', () => {
  const oct = 'application/octet-stream';
  it.each([
    ['file.pdf', FileText],
    ['file.doc', FileText],
    ['file.docx', FileText],
    ['file.odt', FileText],
    ['file.rtf', FileText],
    ['file.xls', FileSpreadsheet],
    ['file.xlsx', FileSpreadsheet],
    ['file.ods', FileSpreadsheet],
    ['file.csv', FileSpreadsheet],
    ['file.tsv', FileSpreadsheet],
    ['file.ppt', FileImage],
    ['file.pptx', FileImage],
    ['file.odp', FileImage],
    ['file.zip', FileArchive],
    ['file.rar', FileArchive],
    ['file.tar', FileArchive],
    ['file.gz', FileArchive],
    ['file.7z', FileArchive],
    ['video.mp4', FileVideo],
    ['video.mov', FileVideo],
    ['video.avi', FileVideo],
    ['video.mkv', FileVideo],
    ['video.webm', FileVideo],
    ['song.mp3', FileAudio],
    ['song.wav', FileAudio],
    ['song.flac', FileAudio],
    ['song.ogg', FileAudio],
    ['song.m4a', FileAudio],
    ['data.json', FileCode],
    ['data.xml', FileCode],
    ['cfg.yaml', FileCode],
    ['cfg.yml', FileCode],
    ['app.js', FileCode],
    ['app.ts', FileCode],
    ['app.tsx', FileCode],
    ['app.jsx', FileCode],
    ['main.go', FileCode],
    ['main.py', FileCode],
    ['main.rb', FileCode],
    ['Main.java', FileCode],
    ['main.c', FileCode],
    ['main.h', FileCode],
    ['main.cpp', FileCode],
    ['Program.cs', FileCode],
    ['main.rs', FileCode],
    ['run.sh', FileCode],
    ['readme.md', FileCode],
    ['unknown.xyz', File],
    ['no-extension', File],
  ])('octet-stream + %s → expected icon', (filename, expected) => {
    expect(iconForAttachment(oct, filename)).toBe(expected);
  });

  it('falls back to File when content type is empty and filename has no extension', () => {
    expect(iconForAttachment('', '')).toBe(File);
  });

  it('handles uppercase extensions', () => {
    expect(iconForAttachment(oct, 'PHOTO.PDF')).toBe(FileText);
  });
});
