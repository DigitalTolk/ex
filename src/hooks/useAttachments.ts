import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { useMemo } from 'react';
import { apiFetch } from '@/lib/api';
import { isImageAttachment } from '@/lib/file-helpers';
import { queryKeys } from '@/lib/query-keys';
import type { Attachment } from '@/types';

interface UploadInitResponse {
  id: string;
  // The attachment's object key; bytes go straight to S3 under it.
  key: string;
  // Set when an earlier attempt at this same file left a multipart upload
  // open: the upload resumes it instead of starting over.
  multipartUploadId: string;
  alreadyExists: boolean;
  filename: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
}

// HASH_CHUNK_BYTES bounds how much of a file sits in memory while it is
// hashed. WebCrypto can only digest a whole buffer, which meant reading the
// entire file into the tab (plus SubtleCrypto's own copy) before uploading —
// enough to crash a webview or Electron renderer on a large attachment.
export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

// sha256File hashes a file incrementally, one slice at a time.
export async function sha256File(file: Blob, chunkBytes = HASH_CHUNK_BYTES): Promise<string> {
  const hasher = sha256.create();
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    const chunk = await file.slice(offset, offset + chunkBytes).arrayBuffer();
    hasher.update(new Uint8Array(chunk));
  }
  return bytesToHex(hasher.digest());
}

// readImageDimensions returns the intrinsic pixel size of an image
// File. Sends them along to the upload-init endpoint so the
// MessageList renderer can reserve the layout box on first paint
// — the same width/height the browser would have measured after
// decode, except known before the image bytes leave the client.
// Returns undefined dimensions for non-images, or if the browser
// can't decode (e.g. corrupt file). The upload still proceeds; the
// server-side backfill will pick up the dimensions later.
async function readImageDimensions(file: File): Promise<{ width?: number; height?: number }> {
  if (!isImageAttachment(file.type, file.name)) return {};
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      URL.revokeObjectURL(url);
      /* istanbul ignore next -- onload only fires after a successful decode, which always yields naturalWidth/Height > 0; a zero-dimension decode is impossible (a failed decode fires onerror instead), so the `: {}` arm is unreachable. */
      resolve(w > 0 && h > 0 ? { width: w, height: h } : {});
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({});
    };
    img.src = url;
  });
}

interface UploadCallbacks {
  onInit?: (init: UploadInitResponse) => void;
  onProgress?: (fraction: number) => void;
}

export async function uploadAttachment(
  file: File,
  callbacks: UploadCallbacks = {},
): Promise<UploadInitResponse> {
  const [sha, dims] = await Promise.all([
    sha256File(file),
    readImageDimensions(file),
  ]);
  const init = await apiFetch<UploadInitResponse>('/api/v1/attachments/url', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      sha256: sha,
      width: dims.width,
      height: dims.height,
    }),
  });
  callbacks.onInit?.(init);
  if (!init.alreadyExists) {
    await uploadToS3(file, init, (fraction) => callbacks.onProgress?.(fraction * 0.9));
  }
  await processAttachment(init.id);
  callbacks.onProgress?.(1);
  return init;
}

async function processAttachment(id: string): Promise<void> {
  await apiFetch(`/api/v1/attachments/${encodeURIComponent(id)}/process`, {
    method: 'POST',
  });
}

// Files above this go up as an S3 multipart upload: parts are retried on their
// own, a dropped connection resumes where it stopped, and re-attaching the
// same file after a reload resumes the open upload. Smaller files take one PUT
// that S3 checks against the file's SHA-256 itself.
export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;

interface SignedUploadRequest {
  url: string;
  key: string;
  headers: Record<string, string>;
}

// uploadToS3 sends the file straight to the bucket with Uppy's S3 plugin; the
// server only signs each S3 request (create / part / complete / ...), never
// sees the bytes. A remembered multipart upload that S3 no longer knows
// (aborted, expired) falls back to a fresh upload.
async function uploadToS3(file: File, init: UploadInitResponse, onProgress: (fraction: number) => void) {
  if (!init.multipartUploadId) return runUppyUpload(file, init, false, onProgress);
  try {
    await runUppyUpload(file, init, true, onProgress);
  } catch {
    await runUppyUpload(file, init, false, onProgress);
  }
}

async function runUppyUpload(file: File, init: UploadInitResponse, resume: boolean, onProgress: (fraction: number) => void) {
  // Loaded on the first upload, not with the app.
  const [{ default: Uppy }, { default: AwsS3 }] = await Promise.all([import('@uppy/core'), import('@uppy/aws-s3')]);
  const uppy = new Uppy({ id: `attachment-${init.id}` });
  uppy.use(AwsS3, {
    shouldUseMultipart: () => file.size > MULTIPART_THRESHOLD_BYTES,
    generateObjectKey: () => init.key,
    signRequest: (request) =>
      apiFetch<SignedUploadRequest>(`/api/v1/attachments/${encodeURIComponent(init.id)}/upload-request`, {
        method: 'POST',
        body: JSON.stringify(request),
      }),
  });
  // Report only integer-percent changes: every update walks the draft list in
  // MessageInput, so a large upload would otherwise re-render hundreds of
  // times for nothing.
  let lastPct = -1;
  uppy.on('upload-progress', (_file, progress) => {
    const fraction = progress.bytesUploaded / file.size;
    const pct = Math.floor(fraction * 100);
    if (pct === lastPct) return;
    lastPct = pct;
    onProgress(fraction);
  });
  let uploadError: unknown;
  uppy.on('upload-error', (_file, error) => {
    uploadError = error;
  });
  try {
    const fileID = uppy.addFile({ name: file.name, type: file.type, data: file });
    if (resume) {
      uppy.setFileState(fileID, { s3Multipart: { uploadId: init.multipartUploadId, key: init.key } });
    }
    await uppy.upload();
    if (uploadError) throw uploadError;
    // Uppy only reports what the progress events saw; mark the upload done.
    onProgress(1);
  } finally {
    uppy.destroy();
  }
}

export interface AttachmentAccessContext {
  parentID?: string;
  parentType?: 'channel' | 'conversation';
  messageID?: string;
}

function attachmentContextQuery(ctx?: AttachmentAccessContext): string {
  const params = new URLSearchParams();
  if (ctx?.parentID) params.set('parentID', ctx.parentID);
  if (ctx?.parentType) params.set('parentType', ctx.parentType);
  if (ctx?.messageID) params.set('messageID', ctx.messageID);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useAttachment(id: string | undefined, ctx?: AttachmentAccessContext) {
  return useQuery({
    queryKey: queryKeys.attachment(`${id ?? ''}:${ctx?.parentType ?? ''}:${ctx?.parentID ?? ''}:${ctx?.messageID ?? ''}`),
    queryFn: async () => (await apiFetch<Attachment>(`/api/v1/attachments/${id}${attachmentContextQuery(ctx)}`)) ?? null,
    enabled: !!id,
    // Signed URLs can carry temporary AWS session tokens. Refetch on a short
    // cadence so long-lived tabs do not keep rendering expired-token URLs.
    staleTime: 5 * 60 * 1000,
  });
}

// useAttachmentsBatch resolves a list of attachment IDs in a single request
// and hydrates the per-id query cache so any nested useAttachment(id) reuses
// the result without an extra round-trip. Returns a stable id→attachment map.
export function useAttachmentsBatch(ids: string[], ctx?: AttachmentAccessContext) {
  const qc = useQueryClient();
  // Sort for a stable cache key — same set of IDs in any order shares a query.
  const sorted = useMemo(() => [...ids].sort(), [ids]);
  const key = sorted.join(',');
  const ctxKey = `${ctx?.parentType ?? ''}:${ctx?.parentID ?? ''}:${ctx?.messageID ?? ''}`;

  const query = useQuery({
    queryKey: queryKeys.attachmentsBatch(`${key}:${ctxKey}`),
    queryFn: async () => {
      const params = new URLSearchParams({ ids: key });
      if (ctx?.parentID) params.set('parentID', ctx.parentID);
      if (ctx?.parentType) params.set('parentType', ctx.parentType);
      if (ctx?.messageID) params.set('messageID', ctx.messageID);
      const list = await apiFetch<Attachment[]>(`/api/v1/attachments?${params.toString()}`);
      for (const a of list) {
        qc.setQueryData(queryKeys.attachment(a.id), a);
      }
      return list;
    },
    enabled: sorted.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const map = useMemo(() => {
    const m = new Map<string, Attachment>();
    for (const a of query.data ?? []) m.set(a.id, a);
    return m;
  }, [query.data]);

  return { ...query, map };
}

export function useDeleteDraftAttachment() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/v1/attachments/${id}`, { method: 'DELETE' }),
  });
}
