import { describe, it, expect } from 'vitest';
import { canLeaveChannel, GENERAL_CHANNEL_SLUG } from '@/lib/roles';

describe('canLeaveChannel - #general lockdown', () => {
  it('returns false for #general regardless of role', () => {
    expect(canLeaveChannel('member', GENERAL_CHANNEL_SLUG)).toBe(false);
    expect(canLeaveChannel('admin', GENERAL_CHANNEL_SLUG)).toBe(false);
    expect(canLeaveChannel('owner', GENERAL_CHANNEL_SLUG)).toBe(false);
  });

  it('still returns true for non-general channel members', () => {
    expect(canLeaveChannel('member', 'random')).toBe(true);
    expect(canLeaveChannel('admin', 'random')).toBe(true);
  });

  it('still blocks owners from leaving non-general channels', () => {
    expect(canLeaveChannel('owner', 'random')).toBe(false);
  });

  it('GENERAL_CHANNEL_SLUG matches the well-known slug', () => {
    expect(GENERAL_CHANNEL_SLUG).toBe('general');
  });
});
