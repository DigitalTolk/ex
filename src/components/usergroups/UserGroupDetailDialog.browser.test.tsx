import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { UserGroupDetailDialog } from './UserGroupDetailDialog';

const GROUP = {
  id: 'group-oncall', handle: 'oncall', name: 'On-call engineers', description: '', disabled: false,
  memberCount: 1, createdBy: 'u-1', createdAt: '', updatedAt: '', memberIds: ['u-1'],
  entraGroupId: 'entra-oncall', entraGroupName: 'On-call engineers', syncedAt: new Date().toISOString(), syncSkipped: 0,
};
const idle = { mutate: vi.fn(), isPending: false };
vi.mock('@/hooks/useUserGroups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useUserGroups')>()),
  useUserGroup: () => ({ data: GROUP, isLoading: false }),
  useSetUserGroupEnabled: () => idle,
  useSyncUserGroup: () => idle,
}));
vi.mock('@/hooks/useConversations', () => ({
  useAllUsers: () => ({ data: [{ id: 'u-1', displayName: 'Ann', status: 'active' }] }),
}));

// An admin with the Microsoft 365 integration sees every action in the
// footer: they must all fit the dialog, never push it into scrolling sideways.
describe('UserGroupDetailDialog layout', () => {
  afterEach(() => cleanup());

  it('fits every action without scrolling sideways', async () => {
    const screen = await render(<UserGroupDetailDialog groupId={GROUP.id} canManage canLinkMicrosoft onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    await expect.element(screen.getByRole('button', { name: 'Change Microsoft 365 group' })).toBeVisible();

    const box = dialog.element() as HTMLElement;
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    const edge = box.getBoundingClientRect();
    for (const name of ['Change Microsoft 365 group', 'Sync now', 'Disable group', 'Edit details']) {
      const button = screen.getByRole('button', { name }).element().getBoundingClientRect();
      expect(button.left, name).toBeGreaterThanOrEqual(edge.left - 1);
      expect(button.right, name).toBeLessThanOrEqual(edge.right + 1);
    }
  });
});
