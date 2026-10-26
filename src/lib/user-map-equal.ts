import type { UserMapEntry } from '@/components/chat/MessageList';

// sameUserMap: two author lookups show the same thing — same users, names,
// avatars and statuses.
export function sameUserMap(a: Record<string, UserMapEntry>, b: Record<string, UserMapEntry>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const id of keys) {
    const x = a[id];
    const y = b[id];
    if (!y || x.displayName !== y.displayName || x.avatarURL !== y.avatarURL) return false;
    const s = x.userStatus;
    const t = y.userStatus;
    if (s !== t && (!s || !t || s.emoji !== t.emoji || s.text !== t.text || s.clearAt !== t.clearAt)) return false;
  }
  return true;
}
