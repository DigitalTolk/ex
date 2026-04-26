import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AboutDialog } from '@/components/AboutDialog';

describe('AboutDialog', () => {
  it('renders the project name and a link to the repository', () => {
    render(<AboutDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByText('ex')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /github.com\/DigitalTolk\/ex/ });
    expect(link.getAttribute('href')).toBe('https://github.com/DigitalTolk/ex');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('does not render when closed', () => {
    render(<AboutDialog open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByText('ex')).toBeNull();
  });
});
