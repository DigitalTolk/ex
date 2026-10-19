import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  ImageComparison,
  ImageComparisonHandle,
  ImageComparisonImage,
  ImageComparisonLabel,
} from './image-comparison';

function renderComparison(props: { enableHover?: boolean; defaultPosition?: number } = {}) {
  const utils = render(
    <ImageComparison aria-label="Real vs mockup" {...props}>
      <ImageComparisonImage side="after" src="/after.png" alt="After" />
      <ImageComparisonImage side="before" src="/before.png" alt="Before" />
      <ImageComparisonLabel side="before">Real page</ImageComparisonLabel>
      <ImageComparisonLabel side="after">Mockup</ImageComparisonLabel>
      <ImageComparisonHandle />
    </ImageComparison>,
  );
  const stage = utils.container.querySelector('[data-slot="image-comparison"]') as HTMLDivElement;
  stage.getBoundingClientRect = () => ({ left: 100, width: 400, top: 0, height: 250, right: 500, bottom: 250, x: 100, y: 0, toJSON: () => ({}) });
  return { ...utils, stage, slider: screen.getByRole('slider', { name: 'Real vs mockup' }) };
}

describe('ImageComparison', () => {
  it('starts centered with slider semantics and clips both images', async () => {
    const { slider } = renderComparison();
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    expect(slider).toHaveAttribute('aria-valuetext', '50% before');
    await waitFor(() => expect(screen.getByAltText('Before').style.clipPath).toBe('inset(0 50% 0 0)'));
    expect(screen.getByAltText('After').style.clipPath).toBe('inset(0 0 0 50%)');
  });

  it('drags with the pointer, clamped to the stage', async () => {
    const { stage, slider } = renderComparison();
    stage.setPointerCapture = vi.fn();
    fireEvent.pointerDown(stage, { clientX: 200, pointerId: 1, pointerType: 'mouse', button: 0 });
    expect(stage.setPointerCapture).toHaveBeenCalledWith(1);
    expect(slider).toHaveAttribute('aria-valuenow', '25');
    fireEvent.pointerMove(stage, { clientX: 900, pointerId: 1 });
    expect(slider).toHaveAttribute('aria-valuenow', '100');
    fireEvent.pointerMove(stage, { clientX: 0, pointerId: 1 });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    fireEvent.pointerUp(stage);
    fireEvent.pointerMove(stage, { clientX: 300 });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    fireEvent.pointerDown(stage, { clientX: 300, pointerType: 'touch' });
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    fireEvent.pointerCancel(stage);
    fireEvent.pointerMove(stage, { clientX: 400 });
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    await waitFor(() => expect(screen.getByAltText('Before').style.clipPath).toBe('inset(0 50% 0 0)'));
  });

  it('ignores secondary mouse buttons and a zero-width stage', () => {
    const { stage, slider } = renderComparison();
    fireEvent.pointerDown(stage, { clientX: 150, pointerType: 'mouse', button: 2 });
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    stage.getBoundingClientRect = () => ({ left: 0, width: 0, top: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(stage, { clientX: 150, pointerType: 'mouse', button: 0 });
    expect(slider).toHaveAttribute('aria-valuenow', '50');
  });

  it('follows the pointer on hover when enabled', () => {
    const { stage, slider } = renderComparison({ enableHover: true, defaultPosition: 140 });
    expect(slider).toHaveAttribute('aria-valuenow', '100');
    fireEvent.pointerMove(stage, { clientX: 400 });
    expect(slider).toHaveAttribute('aria-valuenow', '75');
  });

  it('moves with the keyboard', () => {
    const { slider } = renderComparison();
    const press = (key: string, shiftKey = false) => fireEvent.keyDown(slider, { key, shiftKey });
    press('ArrowLeft');
    expect(slider).toHaveAttribute('aria-valuenow', '48');
    press('ArrowRight', true);
    expect(slider).toHaveAttribute('aria-valuenow', '58');
    press('ArrowDown');
    press('ArrowUp');
    press('PageDown');
    expect(slider).toHaveAttribute('aria-valuenow', '48');
    press('PageUp');
    expect(slider).toHaveAttribute('aria-valuenow', '58');
    press('Home');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    press('End');
    expect(slider).toHaveAttribute('aria-valuenow', '100');
    press('a');
    expect(slider).toHaveAttribute('aria-valuenow', '100');
  });

  it('has a default accessible name', () => {
    render(
      <ImageComparison>
        <ImageComparisonHandle />
      </ImageComparison>,
    );
    expect(screen.getByRole('slider', { name: 'Before and after' })).toBeInTheDocument();
  });

  it('refuses parts rendered outside a comparison', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ImageComparisonHandle />)).toThrow('must be rendered inside <ImageComparison>');
    err.mockRestore();
  });
});
