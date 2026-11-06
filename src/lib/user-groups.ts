import { MAX_USER_GROUP_MEMBERS } from '@/lib/limits';
import type { User } from '@/types';
import type { UserGroupLinkPreview } from '@/types/generated';

// Only active people can be in a user group: no guests, bots or deactivated
// accounts (the server refuses them too).
export function canBeGroupMember(u: User): boolean {
  return !u.isBot && u.systemRole !== 'guest' && u.status !== 'deactivated';
}

// linkSummary says what linking a group to Microsoft 365 will do, or why it
// can't.
export function linkSummary(preview: UserGroupLinkPreview): string {
  if (preview.overLimit) {
    return `This Microsoft 365 group has more than ${MAX_USER_GROUP_MEMBERS} people, so it can't be linked.`;
  }
  const parts = [`Adds ${preview.toAdd}`];
  if (preview.toRemove > 0) parts.push(`removes ${preview.toRemove}`);
  if (preview.skipped > 0) parts.push(`${preview.skipped} aren't in ex yet`);
  return parts.join(' · ');
}
