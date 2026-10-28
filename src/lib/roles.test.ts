import { describe, it, expect } from 'vitest';
import {
  ChannelRole,
  assignableRoles,
  roleNumber,
  isOwner,
  canEditChannel,
  canArchiveChannel,
  canUnarchiveChannel,
  canLeaveChannel,
  canAddMembers,
  canManageMembers,
  canRemoveMember,
  isAdmin,
  isGuest,
  SystemRole,
  GENERAL_CHANNEL_SLUG,
} from './roles';

describe('roleNumber', () => {
  it('maps null/undefined to 0', () => {
    expect(roleNumber(null)).toBe(0);
    expect(roleNumber(undefined)).toBe(0);
  });
  it('passes numbers through', () => {
    expect(roleNumber(ChannelRole.Owner)).toBe(3);
    expect(roleNumber(2)).toBe(2);
  });
  it('maps string role names', () => {
    expect(roleNumber('owner')).toBe(ChannelRole.Owner);
    expect(roleNumber('admin')).toBe(ChannelRole.Admin);
    expect(roleNumber('member')).toBe(ChannelRole.Member);
  });
  it('maps unrecognized strings to 0 (default branch)', () => {
    expect(roleNumber('guest')).toBe(0);
    expect(roleNumber('whatever')).toBe(0);
  });
});

describe('channel role predicates', () => {
  it('isOwner', () => {
    expect(isOwner('owner')).toBe(true);
    expect(isOwner('admin')).toBe(false);
  });
  it('canEditChannel: admin, owner or a system admin', () => {
    expect(canEditChannel('admin')).toBe(true);
    expect(canEditChannel('owner')).toBe(true);
    expect(canEditChannel('member')).toBe(false);
    expect(canEditChannel('member', 'admin')).toBe(true);
    expect(canEditChannel('member', 'member')).toBe(false);
  });
  it('assignableRoles mirrors the server: owners and system admins hand out ownership', () => {
    // A system admin may give anyone any other role, even as a plain member.
    expect(assignableRoles('member', 'member', 'admin')).toEqual(['owner', 'admin']);
    expect(assignableRoles('member', 'owner', 'admin')).toEqual(['admin', 'member']);
    // An owner likewise, a co-owner included.
    expect(assignableRoles('owner', 'admin')).toEqual(['owner', 'member']);
    expect(assignableRoles('owner', 'owner', 'member')).toEqual(['admin', 'member']);
    // An admin moves people between member and admin, and leaves owners be.
    expect(assignableRoles('admin', 'member')).toEqual(['admin']);
    expect(assignableRoles('admin', 'admin')).toEqual(['member']);
    expect(assignableRoles('admin', 'owner')).toEqual([]);
    // A plain member changes nobody.
    expect(assignableRoles('member', 'member')).toEqual([]);
    expect(assignableRoles(undefined, 'member', 'member')).toEqual([]);
  });
  it('canArchiveChannel / canUnarchiveChannel: owner or system admin', () => {
    expect(canArchiveChannel('owner')).toBe(true);
    expect(canArchiveChannel('admin')).toBe(false);
    expect(canArchiveChannel('member', 'admin')).toBe(true);
    expect(canArchiveChannel('member', 'member')).toBe(false);
    expect(canUnarchiveChannel('owner')).toBe(true);
    expect(canUnarchiveChannel(null, 'admin')).toBe(true);
    expect(canUnarchiveChannel('admin', 'member')).toBe(false);
  });
  it('canLeaveChannel: not general, not owner, must be a member', () => {
    expect(canLeaveChannel('member')).toBe(true);
    expect(canLeaveChannel('owner')).toBe(false);
    expect(canLeaveChannel('member', GENERAL_CHANNEL_SLUG)).toBe(false);
    expect(canLeaveChannel(null)).toBe(false); // not a member at all
  });
  it('canManageMembers: admin or owner', () => {
    expect(canManageMembers('admin')).toBe(true);
    expect(canManageMembers('member')).toBe(false);
  });

  it('canAddMembers: any member can invite (but not a non-member)', () => {
    expect(canAddMembers('member')).toBe(true);
    expect(canAddMembers('admin')).toBe(true);
    expect(canAddMembers('owner')).toBe(true);
    expect(canAddMembers(undefined)).toBe(false);
    expect(canAddMembers(0)).toBe(false);
  });
  it('canRemoveMember: manager acting on a non-owner', () => {
    expect(canRemoveMember('admin', 'member')).toBe(true);
    expect(canRemoveMember('admin', 'owner')).toBe(false);
    expect(canRemoveMember('member', 'member')).toBe(false);
  });

  it('canRemoveMember: nobody can be removed from #general (backend rejects it)', () => {
    expect(canRemoveMember('owner', 'member', 'general')).toBe(false);
    expect(canRemoveMember('admin', 'member', 'general')).toBe(false);
    // Any other slug leaves the role rules in charge.
    expect(canRemoveMember('admin', 'member', 'random')).toBe(true);
  });
});

describe('system role predicates', () => {
  it('isAdmin / isGuest', () => {
    expect(isAdmin(SystemRole.Admin)).toBe(true);
    expect(isAdmin('member')).toBe(false);
    expect(isGuest(SystemRole.Guest)).toBe(true);
    expect(isGuest(undefined)).toBe(false);
  });
});
