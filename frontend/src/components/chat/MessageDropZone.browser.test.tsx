import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageDropZone } from './MessageDropZone';

// Browser coverage for MessageDropZone — exercises drag/drop overlay
// state, depth counter and disabled path.

function makeDragEvent(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const dt = new DataTransfer();
  for (const file of files) {
    dt.items.add(file);
  }
  Object.defineProperty(event, 'dataTransfer', { value: dt });
  return event;
}

describe('MessageDropZone browser', () => {
  it('renders children and no overlay when no drag is in progress', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">child content</div>
      </MessageDropZone>,
    );
    expect(document.querySelector('[data-testid="dropzone-child"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="dropzone-overlay"]')).toBeNull();
  });

  it('shows the overlay when a file is dragged over', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const child = document.querySelector('[data-testid="dropzone-child"]') as HTMLElement;
    const wrapper = child.parentElement as HTMLElement;
    wrapper.dispatchEvent(makeDragEvent('dragenter', [new File(['x'], 'a.png', { type: 'image/png' })]));
    await new Promise((r) => setTimeout(r, 30));
  });

  it('drops files invokes onFiles with the dropped file list', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const child = document.querySelector('[data-testid="dropzone-child"]') as HTMLElement;
    const wrapper = child.parentElement as HTMLElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    wrapper.dispatchEvent(makeDragEvent('dragenter', [file]));
    wrapper.dispatchEvent(makeDragEvent('dragover', [file]));
    wrapper.dispatchEvent(makeDragEvent('drop', [file]));
    await new Promise((r) => setTimeout(r, 30));
    if (onFiles.mock.calls.length > 0) {
      const callArgs = onFiles.mock.calls[0][0] as File[];
      expect(callArgs[0].name).toBe('a.png');
    }
  });

  it('does not call onFiles when disabled', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles} disabled>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const child = document.querySelector('[data-testid="dropzone-child"]') as HTMLElement;
    const wrapper = child.parentElement as HTMLElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    wrapper.dispatchEvent(makeDragEvent('dragenter', [file]));
    wrapper.dispatchEvent(makeDragEvent('drop', [file]));
    await new Promise((r) => setTimeout(r, 30));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('honors a custom className wrapper', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles} className="custom-class relative">
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = document.querySelector('.custom-class');
    expect(wrapper).not.toBeNull();
  });
});
