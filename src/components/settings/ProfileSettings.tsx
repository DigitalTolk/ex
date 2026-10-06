import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/context/AuthContext';
import { apiFetch, getAccessToken } from '@/lib/api';
import { AuthProvider } from '@/lib/roles';
import { getInitials } from '@/lib/format';
import type { User } from '@/types';
import { SettingsRow, SettingsSection } from './settings-ui';
import { useSaveTracker } from './save-status';

const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export function ProfileSettings() {
  const { user, setAuth } = useAuth();
  const track = useSaveTracker();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [isUploading, setIsUploading] = useState(false);
  const [isSavingName, setIsSavingName] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* istanbul ignore next -- SettingsDialog only renders pages for a signed-in user */
  if (!user) return null;

  // SSO-managed users get their name from the identity provider; only guest
  // (password) accounts can rename themselves. The server enforces the same.
  const canRename = user.authProvider === AuthProvider.Guest;
  const trimmed = displayName.trim();
  const nameDirty = canRename && trimmed !== '' && trimmed !== user.displayName;

  async function patchMe(body: Record<string, string>) {
    const updated = await track(
      apiFetch<User>('/api/v1/users/me', { method: 'PATCH', body: JSON.stringify(body) }),
    );
    const token = getAccessToken();
    if (token) setAuth(token, updated);
    return updated;
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) {
      setError('Only JPEG, PNG, or WebP images are allowed');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError('Image must be smaller than 2MB');
      return;
    }
    setError('');
    setIsUploading(true);
    try {
      // 1. Presigned PUT URL from the backend, 2. upload straight to storage,
      // 3. point the profile at the new key — saved immediately, no Save button.
      const { uploadURL, key } = await apiFetch<{ uploadURL: string; key: string }>(
        '/api/v1/users/me/avatar/upload-url',
        { method: 'POST', body: JSON.stringify({ contentType: file.type, size: file.size }) },
      );
      const putRes = await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
      await patchMe({ avatarKey: key });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Avatar upload failed');
    } finally {
      setIsUploading(false);
    }
  }

  async function saveName() {
    // Enter in an unchanged (or SSO read-only) field is a no-op.
    if (!nameDirty) return;
    setError('');
    setIsSavingName(true);
    try {
      const updated = await patchMe({ displayName: trimmed });
      setDisplayName(updated.displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setIsSavingName(false);
    }
  }

  function cancelName() {
    setDisplayName(user!.displayName);
  }

  return (
    <>
      {error && (
        <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      <SettingsSection>
        <div className="flex items-center gap-[18px] pt-1 pb-5">
          <Avatar className="h-16 w-16">
            <AvatarImage src={user.avatarURL} alt="" />
            <AvatarFallback className="text-lg">{getInitials(user.displayName || '??')}</AvatarFallback>
          </Avatar>
          <div>
            <div className="font-medium">Photo</div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">JPEG, PNG or WebP, up to 2 MB.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              data-testid="settings-upload-avatar"
            >
              {isUploading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {isUploading ? 'Uploading…' : 'Upload photo'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept={AVATAR_TYPES.join(',')}
              className="hidden"
              onChange={handleFileSelect}
              data-testid="settings-avatar-input"
            />
          </div>
        </div>

        <SettingsRow
          label="Display name"
          htmlFor="settings-display-name"
          hint={
            canRename
              ? 'How you appear in messages and the directory.'
              : 'Managed by your sign-in provider.'
          }
        >
          <div className="w-80 max-w-full narrow:w-full">
            <Input
              id="settings-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveName();
                if (e.key === 'Escape' && nameDirty) {
                  e.stopPropagation();
                  cancelName();
                }
              }}
              placeholder="Your name"
              readOnly={!canRename}
              disabled={!canRename}
              className="bg-muted"
            />
            {nameDirty && (
              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={cancelName}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={saveName} disabled={isSavingName}>
                  {isSavingName ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Email"
          htmlFor="settings-email"
          hint="Comes from your sign-in and can't be changed here."
        >
          <Input
            id="settings-email"
            value={user.email}
            readOnly
            disabled
            className="w-80 max-w-full bg-muted narrow:w-full"
          />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
