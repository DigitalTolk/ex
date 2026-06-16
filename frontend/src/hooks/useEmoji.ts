import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { EMOJI_FREQUENCY_CHANGED_EVENT, getFrequentEmojis } from '@/lib/emoji-frequency';
import type { CustomEmoji } from '@/types';

// How many frequently-used emoji to fetch for the message action bar's
// quick-reaction shortcuts; callers slice to the few they show.
const FREQUENT_REACTIONS_FETCH = 18;

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

export function useEmojiMap(enabled = true) {
  return useQuery({
    queryKey: queryKeys.emojis(),
    queryFn: fetchEmojis,
    staleTime: 5 * 60 * 1000,
    enabled,
    select: (list) => {
      const map: Record<string, string> = {};
      for (const e of list) map[e.name] = e.imageURL;
      return map;
    },
  });
}

// useFrequentEmojis returns the signed-in user's most-used emoji shortcodes
// (server-backed, Redis). Used by the message action bar for quick reactions.
// Pass a limit to cap how many are returned.
export function useFrequentEmojis(limit?: number) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.frequentEmojis(),
    queryFn: () => getFrequentEmojis(FREQUENT_REACTIONS_FETCH),
    staleTime: 60 * 1000,
  });
  // Refresh the moment any emoji is used anywhere (picker pick or quick
  // reaction) so the action bar's popular shelf reorders live instead of
  // waiting out staleTime.
  useEffect(() => {
    const onChanged = () => {
      void qc.invalidateQueries({ queryKey: queryKeys.frequentEmojis() });
    };
    window.addEventListener(EMOJI_FREQUENCY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(EMOJI_FREQUENCY_CHANGED_EVENT, onChanged);
  }, [qc]);
  const list = data ?? [];
  return limit ? list.slice(0, limit) : list;
}

export function useUploadEmoji() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, file }: { name: string; file: File }) => {
      const { uploadURL, key } = await apiFetch<{
        uploadURL: string;
        key: string;
      }>('/api/v1/uploads/url', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });
      const put = await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!put.ok) throw new Error(`Upload failed: ${put.status}`);
      // imageKey lets the server derive and re-sign the URL; do not
      // persist the client-held presigned URL.
      return apiFetch<CustomEmoji>('/api/v1/emojis', {
        method: 'POST',
        body: JSON.stringify({ name, imageKey: key }),
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
