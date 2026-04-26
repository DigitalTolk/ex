// Channel role helpers. Backend serializes role either as the numeric enum
// (1=Member, 2=Admin, 3=Owner) on UserChannel, or as the string form
// ("owner"|"admin"|"member") on ChannelMembership. The helpers below accept
// either shape so call sites don't need to know which payload they're holding.

export const ChannelRole = {
  Member: 1,
  Admin: 2,
  Owner: 3,
} as const;

export type ChannelRoleNum = (typeof ChannelRole)[keyof typeof ChannelRole];
export type ChannelRoleStr = 'owner' | 'admin' | 'member';
export type ChannelRoleLike = ChannelRoleNum | ChannelRoleStr | number | string | undefined | null;

export function roleNumber(role: ChannelRoleLike): number {
  if (role == null) return 0;
  if (typeof role === 'number') return role;
  switch (role) {
    case 'owner': return ChannelRole.Owner;
    case 'admin': return ChannelRole.Admin;
    case 'member': return ChannelRole.Member;
    default: return 0;
  }
}

export function isOwner(role: ChannelRoleLike): boolean {
  return roleNumber(role) === ChannelRole.Owner;
}

// Members can edit channel description if admin or owner.
export function canEditChannel(role: ChannelRoleLike): boolean {
  return roleNumber(role) >= ChannelRole.Admin;
}

// Only owners can archive.
export function canArchiveChannel(role: ChannelRoleLike): boolean {
  return isOwner(role);
}

// Slug of the workspace-wide #general channel. Server-derived but stable;
// duplicated here so the leave button can be disabled before any extra
// round-trip. The backend enforces the same rule authoritatively.
export const GENERAL_CHANNEL_SLUG = 'general';

// System-wide role mirrored from internal/model/user.go SystemRole.
export const SystemRole = {
  Admin: 'admin',
  Member: 'member',
  Guest: 'guest',
} as const;
export type SystemRoleStr = (typeof SystemRole)[keyof typeof SystemRole];

// Auth provider mirrored from internal/model/user.go AuthProvider. Empty /
// undefined is treated as OIDC for legacy accounts (server backfills too).
export const AuthProvider = {
  OIDC: 'oidc',
  Guest: 'guest',
} as const;
export type AuthProviderStr = (typeof AuthProvider)[keyof typeof AuthProvider];

export function isAdmin(role?: SystemRoleStr | string): boolean {
  return role === SystemRole.Admin;
}

export function isGuest(role?: SystemRoleStr | string): boolean {
  return role === SystemRole.Guest;
}

// Owners cannot leave their own channel; nobody can leave #general; everyone
// else can.
export function canLeaveChannel(role: ChannelRoleLike, channelSlug?: string): boolean {
  if (channelSlug === GENERAL_CHANNEL_SLUG) return false;
  const n = roleNumber(role);
  return n > 0 && n !== ChannelRole.Owner;
}

// Admins and owners can manage (add/remove) members.
export function canManageMembers(role: ChannelRoleLike): boolean {
  return roleNumber(role) >= ChannelRole.Admin;
}

// Owners cannot be removed by anyone except themselves (via leave protections).
export function canRemoveMember(actorRole: ChannelRoleLike, targetRole: ChannelRoleLike): boolean {
  return canManageMembers(actorRole) && !isOwner(targetRole);
}
