import { describe, it, expect } from 'vitest';
import {
  ChannelRole,
  roleNumber,
  isOwner,
  canEditChannel,
  canArchiveChannel,
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
  it('canEditChannel: admin or owner', () => {
    expect(canEditChannel('admin')).toBe(true);
    expect(canEditChannel('owner')).toBe(true);
    expect(canEditChannel('member')).toBe(false);
  });
  it('canArchiveChannel: owner only', () => {
    expect(canArchiveChannel('owner')).toBe(true);
    expect(canArchiveChannel('admin')).toBe(false);
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
});

describe('system role predicates', () => {
  it('isAdmin / isGuest', () => {
    expect(isAdmin(SystemRole.Admin)).toBe(true);
    expect(isAdmin('member')).toBe(false);
    expect(isGuest(SystemRole.Guest)).toBe(true);
    expect(isGuest(undefined)).toBe(false);
  });
});
