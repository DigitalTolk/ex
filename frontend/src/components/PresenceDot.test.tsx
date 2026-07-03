import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PresenceDot } from './PresenceDot';
import { presenceNotchStyle } from '@/lib/presence';

// The Slack-style presence contract: one dot implementation, state encoded
// by SHAPE (filled vs hollow) as well as color, nested in a notch the
// avatar masks out of itself.
describe('PresenceDot', () => {
  it('online renders a FILLED dot', () => {
    render(<PresenceDot online size={8} testId="dot" />);
    const dot = screen.getByTestId('dot');
    expect(dot.getAttribute('data-presence')).toBe('online');
    expect(dot.className).toContain('bg-online');
    expect(dot.className).not.toContain('border-solid');
    expect(dot.style.borderWidth).toBe('0px');
    expect(dot).toHaveAccessibleName('Online');
  });

  it('offline renders a HOLLOW ring — distinguishable without color vision', () => {
    render(<PresenceDot online={false} size={8} testId="dot" />);
    const dot = screen.getByTestId('dot');
    expect(dot.getAttribute('data-presence')).toBe('offline');
    expect(dot.className).toContain('border-solid');
    expect(dot.className).toContain('border-muted-foreground');
    expect(dot.className).toContain('bg-transparent');
    expect(dot.className).not.toContain('bg-online');
    expect(dot).toHaveAccessibleName('Offline');
  });

  it('ring thickness scales with the dot but never drops below 1.5px', () => {
    render(
      <>
        <PresenceDot online={false} size={6} testId="small" />
        <PresenceDot online={false} size={12} testId="large" />
      </>,
    );
    expect(screen.getByTestId('small').style.borderWidth).toBe('1.5px');
    // 12 / 4.5 ≈ 2.67px — proportional for larger dots.
    expect(screen.getByTestId('large').style.borderWidth).toContain('2.6');
  });

  it('inset offsets the dot from the avatar corner (grid-card placement)', () => {
    render(<PresenceDot online size={12} inset={8} testId="dot" />);
    const dot = screen.getByTestId('dot');
    expect(dot.style.right).toBe('8px');
    expect(dot.style.bottom).toBe('8px');
  });
});

describe('presenceNotchStyle', () => {
  it('centers the notch on the dot and sizes it dot-radius + gap', () => {
    const style = presenceNotchStyle(12);
    // dot radius 6 → center 6px in from the corner; notch radius 6+2=8.
    expect(style.maskImage).toContain('circle 8px at calc(100% - 6px) calc(100% - 6px)');
    expect(style.WebkitMaskImage).toBe(style.maskImage);
  });

  it('follows an inset dot (e.g. the directory grid cards)', () => {
    const style = presenceNotchStyle(12, 8);
    expect(style.maskImage).toContain('at calc(100% - 14px) calc(100% - 14px)');
  });
});
