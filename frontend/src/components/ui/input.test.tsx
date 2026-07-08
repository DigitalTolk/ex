import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from './input';

describe('Input', () => {
  it('matches default button height on mobile', () => {
    render(<Input aria-label="Example input" />);

    expect(screen.getByLabelText('Example input')).toHaveClass('h-8', 'mobile:h-11');
  });
});
