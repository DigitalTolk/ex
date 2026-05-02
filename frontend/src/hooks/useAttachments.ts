import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { Attachment } from '@/types';

interface UploadInitResponse {
  id: string;
  uploadURL: string;
  alreadyExists: boolean;
  filename: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
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
  if (!file.type.startsWith('image/')) return {};
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      URL.revokeObjectURL(url);
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
  const buf = await file.arrayBuffer();
  const [sha, dims] = await Promise.all([
    sha256Hex(buf),
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
  if (init.alreadyExists) {
    callbacks.onProgress?.(1);
    return init;
  }
  await uploadWithProgress(init.uploadURL, file, callbacks.onProgress);
  return init;
}

function uploadWithProgress(
  url: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  // XHR instead of fetch — fetch has no upload-progress event.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (onProgress && xhr.upload) {
      // Drop subsequent ticks unless the integer-percent changed —
      // every emitted update walks the draft list in MessageInput, so
      // for a 50 MiB upload this avoids ~hundreds of no-op renders.
      let lastPct = -1;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.floor((e.loaded / e.total) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(file);
  });
}

export function useAttachment(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.attachment(id ?? ''),
    queryFn: () => apiFetch<Attachment>(`/api/v1/attachments/${id}`),
    enabled: !!id,
    // Signed URLs last 6h; refetch occasionally so we don't render stale URLs
    // after long-lived sessions.
    staleTime: 60 * 60 * 1000,
  });
}

// useAttachmentsBatch resolves a list of attachment IDs in a single request
// and hydrates the per-id query cache so any nested useAttachment(id) reuses
// the result without an extra round-trip. Returns a stable id→attachment map.
export function useAttachmentsBatch(ids: string[]) {
  const qc = useQueryClient();
  // Sort for a stable cache key — same set of IDs in any order shares a query.
  const sorted = useMemo(() => [...ids].sort(), [ids]);
  const key = sorted.join(',');

  const query = useQuery({
    queryKey: queryKeys.attachmentsBatch(key),
    queryFn: async () => {
      const list = await apiFetch<Attachment[]>(`/api/v1/attachments?ids=${encodeURIComponent(key)}`);
      for (const a of list) {
        qc.setQueryData(queryKeys.attachment(a.id), a);
      }
      return list;
    },
    enabled: sorted.length > 0,
    staleTime: 60 * 60 * 1000,
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
