import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from './dialog';

describe('DialogContent', () => {
  it('uses a full-screen mobile layout', async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = await screen.findByRole('dialog');
    expect(content).toHaveClass(
      'max-md:inset-0',
      'max-md:max-h-none',
      'max-md:rounded-none',
      'max-md:overflow-y-auto',
    );
  });
});
