import { describe, expect, it } from 'vitest';
import {
  ChannelRole,
  roleNumber,
  isOwner,
  canEditChannel,
  canArchiveChannel,
  canLeaveChannel,
  canManageMembers,
  canRemoveMember,
  isAdmin,
  isGuest,
  GENERAL_CHANNEL_SLUG,
} from './roles';

describe('roles — number coercion', () => {
  it('numeric roles pass through unchanged', () => {
    expect(roleNumber(ChannelRole.Owner)).toBe(3);
    expect(roleNumber(ChannelRole.Admin)).toBe(2);
    expect(roleNumber(ChannelRole.Member)).toBe(1);
    expect(roleNumber(0)).toBe(0);
  });

  it('string roles map to the numeric tier', () => {
    expect(roleNumber('owner')).toBe(3);
    expect(roleNumber('admin')).toBe(2);
    expect(roleNumber('member')).toBe(1);
  });

  it('unknown or nullish roles fall through to 0', () => {
    expect(roleNumber('bogus')).toBe(0);
    expect(roleNumber(null)).toBe(0);
    expect(roleNumber(undefined)).toBe(0);
  });
});

describe('roles — capability gates', () => {
  it('isOwner is true only at owner level', () => {
    expect(isOwner('owner')).toBe(true);
    expect(isOwner(ChannelRole.Owner)).toBe(true);
    expect(isOwner('admin')).toBe(false);
    expect(isOwner('member')).toBe(false);
    expect(isOwner(null)).toBe(false);
  });

  it('canEditChannel and canArchiveChannel gate at admin vs owner', () => {
    expect(canEditChannel('admin')).toBe(true);
    expect(canEditChannel('owner')).toBe(true);
    expect(canEditChannel('member')).toBe(false);
    expect(canArchiveChannel('owner')).toBe(true);
    expect(canArchiveChannel('admin')).toBe(false);
  });

  it('canLeaveChannel blocks owners and the #general channel', () => {
    expect(canLeaveChannel('member', 'general')).toBe(false);
    expect(canLeaveChannel('member', GENERAL_CHANNEL_SLUG)).toBe(false);
    expect(canLeaveChannel('owner', 'random')).toBe(false);
    expect(canLeaveChannel('member', 'random')).toBe(true);
    expect(canLeaveChannel(undefined, 'random')).toBe(false);
  });

  it('canManageMembers and canRemoveMember gate by tier and respect owner immunity', () => {
    expect(canManageMembers('admin')).toBe(true);
    expect(canManageMembers('member')).toBe(false);
    expect(canRemoveMember('owner', 'owner')).toBe(false);
    expect(canRemoveMember('owner', 'member')).toBe(true);
    expect(canRemoveMember('member', 'member')).toBe(false);
    // #general never offers removal — the backend rejects it.
    expect(canRemoveMember('owner', 'member', 'general')).toBe(false);
    expect(canRemoveMember('owner', 'member', 'random')).toBe(true);
  });
});

describe('roles — system roles', () => {
  it('isAdmin / isGuest discriminate from arbitrary strings', () => {
    expect(isAdmin('admin')).toBe(true);
    expect(isAdmin('member')).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
    expect(isGuest('guest')).toBe(true);
    expect(isGuest('admin')).toBe(false);
  });
});
