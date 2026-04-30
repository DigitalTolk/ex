import { useState, useRef, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Trash2, ImagePlus, X } from 'lucide-react';
import { useEmojis, useUploadEmoji, useDeleteEmoji } from '@/hooks/useEmoji';
import { useAuth } from '@/context/AuthContext';
import { formatBytes } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NAME_RE = /^[a-z0-9_+-]{1,32}$/;

export function EmojiManagerDialog({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const { data: emojis } = useEmojis(open);
  const upload = useUploadEmoji();
  const remove = useDeleteEmoji();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewURL, setPreviewURL] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [emojiToDelete, setEmojiToDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setName('');
    setFile(null);
    if (previewURL) URL.revokeObjectURL(previewURL);
    setPreviewURL(null);
    setError('');
    if (fileRef.current) fileRef.current.value = '';
  }

  function handleFileChange(f: File | null) {
    if (previewURL) URL.revokeObjectURL(previewURL);
    setFile(f);
    setPreviewURL(f ? URL.createObjectURL(f) : null);
  }

  // Revoke any active preview URL when the dialog unmounts (or on the rare
  // case the previewURL ref changes without going through handleFileChange).
  useEffect(() => {
    return () => {
      if (previewURL) URL.revokeObjectURL(previewURL);
    };
  }, [previewURL]);

  async function handleSave() {
    setError('');
    if (!NAME_RE.test(name)) {
      setError('Name must be 1–32 chars: lowercase letters, digits, _, +, -');
      return;
    }
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Custom emojis</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Use <code className="rounded bg-muted px-1">:name:</code> in any
            message or reaction to insert an emoji.
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <section className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-semibold">Add a new emoji</h3>

            <div className="flex items-start gap-3">
              {/* Image picker / preview tile. The remove (X) lives as a sibling
                  rather than a nested button so the markup stays valid. */}
              <div className="relative h-20 w-20 shrink-0">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="h-full w-full rounded-md border-2 border-dashed bg-muted/30 flex items-center justify-center hover:bg-muted/50 transition-colors"
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
                    className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground hover:bg-muted"
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

              <div className="flex-1 space-y-2 min-w-0">
                <div>
                  <Label htmlFor="emoji-name" className="text-xs">
                    Shortcode
                  </Label>
                  <div className="mt-1 flex items-center rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring">
                    <span className="px-2 text-muted-foreground select-none">:</span>
                    <Input
                      id="emoji-name"
                      value={name}
                      onChange={(e) => setName(e.target.value.toLowerCase())}
                      placeholder="party_parrot"
                      className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
                      aria-label="Emoji shortcode"
                    />
                    <span className="px-2 text-muted-foreground select-none">:</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Lowercase letters, digits, <code>_</code>, <code>+</code>, <code>-</code>. Max 32 chars.
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
              <p className="text-xs text-destructive" role="alert">{error}</p>
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

          <section>
            <h3 className="mb-2 text-sm font-semibold">
              Existing emojis{' '}
              <span className="text-xs font-normal text-muted-foreground">
                ({emojis?.length ?? 0})
              </span>
            </h3>
            <ScrollArea className="max-h-72">
              <div className="grid grid-cols-2 gap-1.5">
                {(emojis ?? []).map((e) => (
                  <div
                    key={e.name}
                    className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                  >
                    <img src={e.imageURL} alt={`:${e.name}:`} className="h-6 w-6" />
                    <span className="flex-1 text-xs font-mono truncate">:{e.name}:</span>
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
                {(!emojis || emojis.length === 0) && (
                  <p className="col-span-2 py-4 text-center text-xs text-muted-foreground">
                    No custom emojis yet. Upload one above to get started.
                  </p>
                )}
              </div>
            </ScrollArea>
          </section>
        </div>
      </DialogContent>
      <ConfirmDialog
        open={emojiToDelete !== null}
        onOpenChange={(o) => {
          if (!o) setEmojiToDelete(null);
        }}
        title="Delete emoji?"
        description={emojiToDelete ? `:${emojiToDelete}: will no longer be available.` : undefined}
        confirmLabel="Delete emoji"
        destructive
        onConfirm={() => {
          if (emojiToDelete) void performDelete(emojiToDelete);
        }}
        testIDPrefix="delete-emoji"
      />
    </Dialog>
  );
}
