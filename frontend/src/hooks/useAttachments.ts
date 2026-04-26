import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiFetch } from '@/lib/api';
import type { Attachment } from '@/types';

interface UploadInitResponse {
  id: string;
  uploadURL: string;
  alreadyExists: boolean;
  filename: string;
  contentType: string;
  size: number;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// uploadAttachment computes SHA256, asks the server for an upload slot, and
// performs the PUT only when the server reports it's a new file. Returns the
// server-side attachment id which can be referenced from a sent message.
export async function uploadAttachment(file: File): Promise<UploadInitResponse> {
  const buf = await file.arrayBuffer();
  const sha = await sha256Hex(buf);
  const init = await apiFetch<UploadInitResponse>('/api/v1/attachments/url', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      sha256: sha,
    }),
  });
  if (!init.alreadyExists) {
    const put = await fetch(init.uploadURL, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    if (!put.ok) throw new Error(`Upload failed: ${put.status}`);
  }
  return init;
}

export function useAttachment(id: string | undefined) {
  return useQuery({
    queryKey: ['attachment', id],
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
    queryKey: ['attachments-batch', key],
    queryFn: async () => {
      const list = await apiFetch<Attachment[]>(`/api/v1/attachments?ids=${encodeURIComponent(key)}`);
      for (const a of list) {
        qc.setQueryData(['attachment', a.id], a);
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
