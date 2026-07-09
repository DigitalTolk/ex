import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readComponent(path: string) {
  // The frontend root IS the repo root (package.json, index.html and src/
  // all live there since the 2026-07 consolidation), which is also vitest's
  // cwd for every run.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
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
