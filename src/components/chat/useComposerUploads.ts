import { useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';
import { uploadAttachment, useDeleteDraftAttachment } from '@/hooks/useAttachments';
import { isImageAttachment } from '@/lib/file-helpers';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@/lib/limits';
import { ApiError } from '@/lib/api';

// Uploads run at most this many at a time.
const UPLOAD_POOL_SIZE = 4;

interface ComposerUploadsOptions {
  drafts: DraftAttachment[];
  setDrafts: Dispatch<SetStateAction<DraftAttachment[]>>;
  markLocallyEdited: () => void;
}

// useComposerUploads turns picked, pasted and dropped files into attachment
// chips: each file gets a chip with a progress bar at once, uploads run in a
// small pool, a failed file drops only its own chip, and removing a chip
// deletes its draft attachment on the server.
export function useComposerUploads({ drafts, setDrafts, markLocallyEdited }: ComposerUploadsOptions) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const deleteDraft = useDeleteDraftAttachment();

  async function uploadFiles(allFiles: File[]) {
    if (allFiles.length === 0) return;
    // Trim to the per-message cap before uploading. Surface a friendly
    // warning if the user tried to attach more — better UX than letting
    // the upload finish and then 400-ing on send.
    const remaining = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - drafts.length);
    const files = allFiles.slice(0, remaining);
    if (allFiles.length > remaining) {
      setUploadError(
        `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message. Skipped ${
          allFiles.length - remaining
        }.`,
      );
    } else {
      setUploadError('');
    }
    if (files.length === 0) return;
    setIsUploading(true);
    markLocallyEdited();

    // Render a chip for every selected file *before* any network I/O so
    // the user sees N progress bars immediately instead of one-at-a-time
    // as each file's SHA / presign call resolves. We track the chip by a
    // local placeholder id, then swap to the server id when init returns.
    const tempIDs = files.map((_, i) => `pending-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`);
    setDrafts((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        id: tempIDs[i],
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        localURL: isImageAttachment(file.type, file.name) ? URL.createObjectURL(file) : undefined,
        progress: 0,
      })),
    ]);

    // Concurrency-capped pool. Promise.all would dispatch all uploads at
    // once; cap the pool so we stay polite to the upload endpoint and don't
    // saturate upstream bandwidth on bulk drops. Per-file failures are
    // captured (allSettled-style) so one bad file doesn't abort siblings.
    const errors: string[] = [];
    let cursor = 0;
    const runOne = async (idx: number) => {
      const file = files[idx];
      const tempID = tempIDs[idx];
      // currentID flips from the temp id to the server-issued id once
      // init resolves. Progress callbacks use this so they can find the
      // chip whether or not the swap has happened yet.
      let currentID = tempID;
      try {
        await uploadAttachment(file, {
          onInit: (init) => {
            // Swap the temp id for the real one. If the server already
            // had the bytes (alreadyExists), progress jumps to 1.
            currentID = init.id;
            setDrafts((prev) =>
              prev.map((d) => {
                if (d.id !== tempID) return d;
                /* istanbul ignore next -- the optimistic chip always seeds progress: 0, so `d.progress` is defined here; the `?? 0` fallback is defensive. */
                const existingProgress = d.progress ?? 0;
                return {
                  ...d,
                  id: init.id,
                  filename: init.filename,
                  contentType: init.contentType,
                  size: init.size,
                  progress: init.alreadyExists ? 1 : existingProgress,
                };
              }),
            );
          },
          onProgress: (fraction) => {
            // Match by the live id — temp before init, server-issued after.
            setDrafts((prev) =>
              prev.map((d) => (d.id === currentID ? { ...d, progress: fraction } : d)),
            );
          },
        });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Upload failed');
        // Drop the failed chip — keep siblings intact. Match by the
        // current id, which may be the temp id (init never resolved)
        // or the server id (init succeeded but the PUT failed).
        setDrafts((prev) => {
          const target = prev.find((d) => d.id === currentID);
          if (target?.localURL) URL.revokeObjectURL(target.localURL);
          return prev.filter((d) => d.id !== currentID);
        });
      }
    };
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= files.length) return;
        await runOne(i);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(UPLOAD_POOL_SIZE, files.length) }, worker));
      if (errors.length > 0) {
        setUploadError(errors.length === 1 ? errors[0] : `${errors.length} uploads failed: ${errors[0]}`);
      }
    } finally {
      setIsUploading(false);
    }
  }

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    /* istanbul ignore next -- a file <input> change always carries a FileList (possibly empty), never null, so the `?? []` fallback is defensive. */
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    await uploadFiles(files);
  }

  async function removeDraft(id: string) {
    const target = drafts.find((d) => d.id === id);
    if (target?.localURL) URL.revokeObjectURL(target.localURL);
    markLocallyEdited();
    setDrafts((d) => d.filter((x) => x.id !== id));
    try {
      await deleteDraft.mutateAsync(id);
    } catch (err) {
      // 409 Conflict is the only "expected" failure: the SHA is still
      // referenced by another message that deduped against this
      // attachment. The chip is gone from the local draft anyway, so
      // the user-visible outcome is correct — swallow it.
      // Anything else (network failure, 5xx, 401) is a real problem
      // the user should see, not silently lose. Surface it via the
      // same upload-error rail that handles failed uploads.
      if (err instanceof ApiError && err.status === 409) return;
      /* istanbul ignore next -- deleteDraft.mutateAsync rejects with Error instances (ApiError/Error); a non-Error rejection is not reachable, so the 'Failed to remove attachment' fallback is defensive. */
      const message = err instanceof Error ? err.message : 'Failed to remove attachment';
      setUploadError(message);
    }
  }

  return { isUploading, uploadError, uploadFiles, handleFileUpload, removeDraft };
}
