import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageContainer } from '@/components/layout/PageContainer';
import { useAuth } from '@/context/AuthContext';
import { useUpdateWorkspaceSettings, useWorkspaceSettings } from '@/hooks/useSettings';
import { isAdmin } from '@/lib/roles';
import { bytesToMib, mibToBytes } from '@/lib/format';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

export default function AdminPage() {
  useDocumentTitle('Admin');
  const { user } = useAuth();
  const { data, isLoading } = useWorkspaceSettings();
  const update = useUpdateWorkspaceSettings();

  // Seed the form straight from the server payload — no useEffect dance.
  // The remount-on-`data?.updatedAt`-style key isn't needed here since
  // React Query keeps the same data reference on stable responses.
  const [maxMB, setMaxMB] = useState(() =>
    data ? String(bytesToMib(data.maxUploadBytes)) : '50',
  );
  const [extensions, setExtensions] = useState(() =>
    data ? data.allowedExtensions.join(', ') : '',
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const lastDataRef = useRef<typeof data>(undefined);

  useEffect(() => {
    if (!data || data === lastDataRef.current) return;
    lastDataRef.current = data;
    setMaxMB(String(bytesToMib(data.maxUploadBytes)));
    setExtensions(data.allowedExtensions.join(', '));
  }, [data]);

  if (!isAdmin(user?.systemRole)) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-sm text-muted-foreground">
          Admin access required.
        </p>
      </div>
    );
  }

  function handleSave() {
    const mb = Number(maxMB);
    const bytes = Number.isFinite(mb) && mb > 0 ? mibToBytes(mb) : 0;
    const exts = extensions
      .split(',')
      .map((e) => e.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean);
    update.mutate(
      { maxUploadBytes: bytes, allowedExtensions: exts },
      {
        onSuccess: () => setSavedAt(Date.now()),
      },
    );
  }

  return (
    <PageContainer
      title="Workspace settings"
      description="Limits and policies that apply to every member."
    >
        <section className="space-y-4 rounded-lg border bg-card p-5">
          <div>
            <h2 className="text-base font-semibold">Attachment uploads</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Restrict the size and types of files members can attach.
              The server enforces both — manipulating the UI doesn't bypass them.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-mb">Max file size (MB)</Label>
            <Input
              id="max-mb"
              type="number"
              min={1}
              value={maxMB}
              onChange={(e) => setMaxMB(e.target.value)}
              className="max-w-xs"
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="extensions">Allowed file extensions</Label>
            <Input
              id="extensions"
              type="text"
              value={extensions}
              onChange={(e) => setExtensions(e.target.value)}
              placeholder="png, jpg, pdf, docx"
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated. Leading dots are optional. Case-insensitive.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save settings'}
            </Button>
            {savedAt && !update.isPending && (
              <span className="text-sm text-muted-foreground" aria-live="polite">
                Saved.
              </span>
            )}
            {update.isError && (
              <span className="text-sm text-destructive" role="alert">
                {update.error instanceof Error ? update.error.message : 'Save failed'}
              </span>
            )}
          </div>
        </section>
    </PageContainer>
  );
}
