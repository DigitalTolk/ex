import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageContainer } from './PageContainer';

describe('PageContainer', () => {
  it('keeps full-page mobile views scrollable inside flex shells', () => {
    render(
      <PageContainer title="Directory">
        <p>Content</p>
      </PageContainer>,
    );

    expect(screen.getByTestId('page-container')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
    );
  });
});
