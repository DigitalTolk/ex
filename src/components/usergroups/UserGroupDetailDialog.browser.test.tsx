import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { UserGroupDetailDialog } from './UserGroupDetailDialog';

const GROUP = {
  id: 'group-oncall', handle: 'oncall', name: 'On-call engineers', description: '', disabled: false,
  memberCount: 1, createdBy: 'u-1', createdAt: '', updatedAt: '', memberIds: ['u-1'],
  syncSkipped: 0, syncState: 'source-missing',
  source: { kind: 'entra-group', id: 'g-oncall', key: 'entra-group:g-oncall' },
};
const idle = { mutate: vi.fn(), isPending: false };
vi.mock('@/hooks/useUserGroups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useUserGroups')>()),
  useUserGroup: () => ({ data: GROUP, isLoading: false }),
  useSetUserGroupEnabled: () => idle,
}));
vi.mock('@/hooks/useConversations', () => ({
  useAllUsers: () => ({ data: [{ id: 'u-1', displayName: 'Ann', status: 'active' }] }),
}));

// An admin sees every action, next to a gone source's note: they must all
// fit the dialog, never push it into scrolling sideways.
describe('UserGroupDetailDialog layout', () => {
  afterEach(() => cleanup());

  it('fits every action without scrolling sideways', async () => {
    const screen = await render(<UserGroupDetailDialog groupId={GROUP.id} canManage onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    await expect.element(screen.getByRole('status')).toBeVisible();

    const box = dialog.element() as HTMLElement;
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    const edge = box.getBoundingClientRect();
    for (const name of ['Disable group']) {
      const button = screen.getByRole('button', { name }).element().getBoundingClientRect();
      expect(button.left, name).toBeGreaterThanOrEqual(edge.left - 1);
      expect(button.right, name).toBeLessThanOrEqual(edge.right + 1);
    }
  });
});
