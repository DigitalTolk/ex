import type { User } from '@/types';

// Only active people can be in a user group: no guests, bots or deactivated
// accounts (the server refuses them too).
export function canBeGroupMember(u: User): boolean {
  return !u.isBot && u.systemRole !== 'guest' && u.status !== 'deactivated';
}
