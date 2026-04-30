import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { CustomEmoji } from '@/types';

async function fetchEmojis(): Promise<CustomEmoji[]> {
  const res = await apiFetch<CustomEmoji[]>('/api/v1/emojis');
  return Array.isArray(res) ? res : [];
}

export function useEmojis(enabled = true) {
  return useQuery({
    queryKey: queryKeys.emojis(),
    queryFn: fetchEmojis,
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

export function useEmojiMap() {
  return useQuery({
    queryKey: queryKeys.emojis(),
    queryFn: fetchEmojis,
    staleTime: 5 * 60 * 1000,
    select: (list) => {
      const map: Record<string, string> = {};
      for (const e of list) map[e.name] = e.imageURL;
      return map;
    },
  });
}

export function useUploadEmoji() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, file }: { name: string; file: File }) => {
      const { uploadURL, fileURL, key } = await apiFetch<{
        uploadURL: string;
        fileURL: string;
        key: string;
      }>('/api/v1/uploads/url', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });
      const put = await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!put.ok) throw new Error(`Upload failed: ${put.status}`);
      // imageKey lets the server re-sign a fresh URL on every list so
      // the catalog never goes dark when the original presign expires.
      return apiFetch<CustomEmoji>('/api/v1/emojis', {
        method: 'POST',
        body: JSON.stringify({ name, imageURL: fileURL, imageKey: key }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.emojis() }),
  });
}

export function useDeleteEmoji() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/v1/emojis/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.emojis() }),
  });
}
