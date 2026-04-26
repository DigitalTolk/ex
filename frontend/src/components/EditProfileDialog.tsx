import { useState, useRef } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { apiFetch, getAccessToken } from '@/lib/api';
import { getInitials } from '@/lib/format';
import type { User } from '@/types';

interface EditProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// EditProfileDialog wraps the body so it remounts (and resets local state)
// every time the dialog opens.
export function EditProfileDialog({ open, onOpenChange }: EditProfileDialogProps) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
        </DialogHeader>
        {open && <EditProfileBody key={user.id + (user.avatarURL ?? '')} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function EditProfileBody({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { user, setAuth } = useAuth();
  const { theme, setTheme } = useTheme();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarKey, setAvatarKey] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Only JPEG, PNG, or WebP images are allowed');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Image must be smaller than 2MB');
      return;
    }
    setError('');
    setIsUploading(true);

    try {
      // 1. Ask backend for a presigned PUT URL.
      const { uploadURL, key } = await apiFetch<{ uploadURL: string; key: string }>(
        '/api/v1/users/me/avatar/upload-url',
        {
          method: 'POST',
          body: JSON.stringify({ contentType: file.type }),
        },
      );

      // 2. PUT the file directly to S3 (no proxying through our server).
      const putRes = await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed: ${putRes.status}`);
      }

      // 3. Show local preview and remember key for save.
      setAvatarPreview(URL.createObjectURL(file));
      setAvatarKey(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Avatar upload failed');
    } finally {
      setIsUploading(false);
    }
  }

  async function handleSave() {
    setError('');
    setIsSaving(true);
    try {
      const body: Record<string, string> = {};
      if (displayName.trim() && displayName.trim() !== user?.displayName) {
        body.displayName = displayName.trim();
      }
      if (avatarKey) {
        body.avatarKey = avatarKey;
      }
      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }
      const updated = await apiFetch<User>('/api/v1/users/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const token = getAccessToken();
      if (token) setAuth(token, updated);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setIsSaving(false);
    }
  }

  if (!user) return null;

  const previewUrl = avatarPreview || user.avatarURL;
  const initials = getInitials(user.displayName || '??');

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <div className="flex items-center gap-4">
        <div className="relative">
          <Avatar className="h-20 w-20">
            <AvatarImage src={previewUrl} alt="" />
            <AvatarFallback className="text-lg">{initials}</AvatarFallback>
          </Avatar>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            aria-label="Change avatar"
          >
            {isUploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div className="text-sm text-muted-foreground">
          <p>Click the camera to change your avatar.</p>
          <p className="text-xs">JPEG, PNG, or WebP. Max 2MB.</p>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileSelect}
      />

      <div className="space-y-2">
        <Label htmlFor="displayName">Display name</Label>
        <Input
          id="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Your name"
          readOnly={user.authProvider === 'oidc'}
          disabled={user.authProvider === 'oidc'}
          className={user.authProvider === 'oidc' ? 'bg-muted' : undefined}
        />
        {user.authProvider === 'oidc' && (
          <p className="text-xs text-muted-foreground">
            Display name is managed by your SSO provider and cannot be changed here.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={user.email} readOnly disabled className="bg-muted" />
        <p className="text-xs text-muted-foreground">
          Email comes from your SSO provider and cannot be changed.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Theme</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={theme === 'light' ? 'default' : 'outline'}
            onClick={() => setTheme('light')}
            size="sm"
            aria-label="Light theme"
          >
            Light
          </Button>
          <Button
            type="button"
            variant={theme === 'dark' ? 'default' : 'outline'}
            onClick={() => setTheme('dark')}
            size="sm"
            aria-label="Dark theme"
          >
            Dark
          </Button>
          <Button
            type="button"
            variant={theme === 'system' ? 'default' : 'outline'}
            onClick={() => setTheme('system')}
            size="sm"
            aria-label="System theme"
          >
            System
          </Button>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isSaving || isUploading}>
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
