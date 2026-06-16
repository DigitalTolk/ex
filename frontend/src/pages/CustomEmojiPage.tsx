import { useState, useRef, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Trash2, ImagePlus, X, Search } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { useEmojis, useUploadEmoji, useDeleteEmoji } from '@/hooks/useEmoji';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useAuth } from '@/context/AuthContext';
import { isGuest } from '@/lib/roles';
import { formatBytes } from '@/lib/format';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

const NAME_RE = /^[a-z0-9_+-]{1,32}$/;

// Full-page custom-emoji manager (replaces the old modal). Built for
// workspaces with hundreds of emojis: a persistent upload panel plus a
// searchable, multi-column grid of every existing emoji.
export default function CustomEmojiPage() {
  useDocumentTitle('Custom emojis');
  const { user } = useAuth();
  const { data: emojis } = useEmojis();
  const creatorIDs = useMemo(() => [...new Set((emojis ?? []).map((e) => e.createdBy))], [emojis]);
  const { map: creatorMap } = useUsersBatch(creatorIDs);
  const upload = useUploadEmoji();
  const remove = useDeleteEmoji();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewURL, setPreviewURL] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [emojiToDelete, setEmojiToDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setName('');
    setFile(null);
    if (previewURL) URL.revokeObjectURL(previewURL);
    setPreviewURL(null);
    setError('');
    /* istanbul ignore next -- fileRef is always attached to the mounted file input, so the null arm is dead defensive */
    if (fileRef.current) fileRef.current.value = '';
  }

  function handleFileChange(f: File | null) {
    if (previewURL) URL.revokeObjectURL(previewURL);
    setFile(f);
    setPreviewURL(f ? URL.createObjectURL(f) : null);
  }

  // Revoke any active preview URL when the page unmounts (or on the rare
  // case the previewURL ref changes without going through handleFileChange).
  useEffect(() => {
    return () => {
      if (previewURL) URL.revokeObjectURL(previewURL);
    };
  }, [previewURL]);

  const filtered = useMemo(() => {
    const list = emojis ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) => e.name.includes(q));
  }, [emojis, filter]);

  async function handleSave() {
    setError('');
    if (!NAME_RE.test(name)) {
      setError('Name must be 1–32 chars: lowercase letters, digits, _, +, -');
      return;
    }
    /* istanbul ignore next -- Save is disabled until a file is chosen, so handleSave never runs without one; the guard is defensive */
    if (!file) {
      setError('Choose an image first');
      return;
    }
    try {
      await upload.mutateAsync({ name, file });
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  async function performDelete(n: string) {
    try {
      await remove.mutateAsync(n);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  const canDelete = (createdBy: string) =>
    user?.systemRole === 'admin' || user?.id === createdBy;

  if (isGuest(user?.systemRole)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p className="text-sm text-muted-foreground">
          Guests can't manage custom emojis.
        </p>
      </div>
    );
  }

  return (
    <PageContainer
      title="Custom emojis"
      description={
        <>
          Upload images and use{' '}
          <code className="rounded bg-muted px-1">:name:</code> in any message
          or reaction to insert them.
        </>
      }
    >
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <div>
          <h2 className="text-base font-semibold">Add a new emoji</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            PNG, JPEG, GIF, WebP, or SVG. Smaller, square images look best.
          </p>
        </div>

        <div className="flex items-start gap-3">
          {/* Image picker / preview tile. The remove (X) lives as a sibling
              rather than a nested button so the markup stays valid. */}
          <div className="relative h-20 w-20 shrink-0">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex h-full w-full items-center justify-center rounded-md border-2 border-dashed bg-muted/30 transition-colors hover:bg-muted/50"
              aria-label="Choose image"
            >
              {previewURL ? (
                <img src={previewURL} alt="" className="max-h-full max-w-full" />
              ) : (
                <ImagePlus className="h-7 w-7 text-muted-foreground" aria-hidden />
              )}
            </button>
            {previewURL && (
              <button
                type="button"
                onClick={() => handleFileChange(null)}
                className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
                aria-label="Remove image"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            aria-label="Emoji image"
            className="hidden"
          />

          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <Label htmlFor="emoji-name" className="text-xs">
                Shortcode
              </Label>
              <div className="mt-1 flex items-center rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring">
                <span className="select-none px-2 text-muted-foreground">:</span>
                <Input
                  id="emoji-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  placeholder="party_parrot"
                  className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
                  aria-label="Emoji shortcode"
                />
                <span className="select-none px-2 text-muted-foreground">:</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Lowercase letters, digits, <code>_</code>, <code>+</code>,{' '}
                <code>-</code>. Max 32 chars.
              </p>
            </div>
            {file && (
              <p className="truncate text-xs text-muted-foreground">
                {file.name} · {formatBytes(file.size)}
              </p>
            )}
          </div>
        </div>

        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            disabled={!name && !file}
          >
            Clear
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={upload.isPending || !name || !file}
          >
            {upload.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border bg-card p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-semibold">
            Existing emojis{' '}
            <span className="text-xs font-normal text-muted-foreground">
              ({emojis?.length ?? 0})
            </span>
          </h2>
          <div className="relative w-full sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search emojis..."
              aria-label="Search custom emojis"
              className="h-9 pl-8"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((e) => (
            <div
              key={e.name}
              className="flex items-center gap-2 rounded-md border px-2 py-1.5"
            >
              <img src={e.imageURL} alt={`:${e.name}:`} className="h-6 w-6" />
              <div className="min-w-0 flex-1">
                <span className="block truncate font-mono text-sm">:{e.name}:</span>
                <span className="block truncate text-xs text-muted-foreground">
                  by {creatorMap.get(e.createdBy)?.displayName ?? 'unknown'}
                </span>
              </div>
              {canDelete(e.createdBy) && (
                <button
                  type="button"
                  onClick={() => setEmojiToDelete(e.name)}
                  aria-label={`Delete :${e.name}:`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
              {emojis && emojis.length > 0
                ? 'No emojis match your search.'
                : 'No custom emojis yet. Upload one above to get started.'}
            </p>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={emojiToDelete !== null}
        onOpenChange={(o) => {
          /* istanbul ignore else -- the confirm dialog has no internal trigger, so onOpenChange only ever fires with o=false */
          if (!o) setEmojiToDelete(null);
        }}
        title="Delete emoji?"
        description={emojiToDelete ? `:${emojiToDelete}: will no longer be available.` : undefined}
        confirmLabel="Delete emoji"
        destructive
        onConfirm={() => {
          /* istanbul ignore else -- onConfirm is only reachable while the confirm dialog is open, which requires emojiToDelete to be set */
          if (emojiToDelete) void performDelete(emojiToDelete);
        }}
        finalFocus={false}
        testIDPrefix="delete-emoji"
      />
    </PageContainer>
  );
}
