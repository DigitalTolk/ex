import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readComponent(path: string) {
  const frontendRoot = process.cwd().endsWith('/frontend')
    ? process.cwd()
    : resolve(process.cwd(), 'frontend');
  return readFileSync(resolve(frontendRoot, path), 'utf8');
}

describe('user menu dialog mobile close controls', () => {
  it.each([
    'src/components/EditProfileDialog.tsx',
    'src/components/UserStatusDialog.tsx',
    'src/components/InviteDialog.tsx',
    'src/components/AboutDialog.tsx',
  ])('%s opts into a visible mobile Cancel close button', (path) => {
    expect(readComponent(path)).toContain('mobileCloseLabel="Cancel"');
  });

  it('uses the same mobile Cancel close affordance for confirmation dialogs launched from the user menu', () => {
    expect(readComponent('src/components/ui/confirm-dialog.tsx')).toContain('mobileCloseLabel="Cancel"');
  });
});
