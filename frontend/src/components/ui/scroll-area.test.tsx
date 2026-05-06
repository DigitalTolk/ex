import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScrollArea } from './scroll-area';

describe('ScrollArea', () => {
  it('keeps its viewport explicitly scrollable', () => {
    render(
      <ScrollArea className="h-12" data-testid="scroll-area">
        <div>Scrollable content</div>
      </ScrollArea>,
    );

    const viewport = screen.getByText('Scrollable content').parentElement;
    expect(viewport).toHaveAttribute('data-slot', 'scroll-area-viewport');
    expect(viewport).toHaveClass('overflow-y-auto');
  });
});
