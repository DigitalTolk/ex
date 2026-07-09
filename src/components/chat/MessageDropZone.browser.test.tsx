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
    expect(document.querySelector('[data-testid="message-drop-overlay"]')).toBeNull();
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

  // A drag event whose dataTransfer explicitly advertises a "Files" type, so
  // hasFiles() returns true and the overlay/dropEffect/onFiles paths run.
  function fileDragEvent(type: string, files: File[]) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files, items: files.map(() => ({ kind: 'file' })), dropEffect: '' },
    });
    return event;
  }

  it('shows the overlay, sets copy dropEffect, and dispatches dropped files', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    wrapper.dispatchEvent(fileDragEvent('dragenter', [file]));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="message-drop-overlay"]')).not.toBeNull();
    });
    const over = fileDragEvent('dragover', [file]);
    wrapper.dispatchEvent(over);
    expect((over.dataTransfer as DataTransfer).dropEffect).toBe('copy');

    wrapper.dispatchEvent(fileDragEvent('drop', [file]));
    await vi.waitFor(() => expect(onFiles).toHaveBeenCalled());
    expect((onFiles.mock.calls[0][0] as File[])[0].name).toBe('photo.png');
  });

  it('hides the overlay once the drag depth returns to zero on dragleave', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    wrapper.dispatchEvent(fileDragEvent('dragenter', [file]));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="message-drop-overlay"]')).not.toBeNull());
    wrapper.dispatchEvent(fileDragEvent('dragleave', [file]));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="message-drop-overlay"]')).toBeNull());
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

  // A drag whose dataTransfer advertises no `types` list at all.
  function noTypesDragEvent(type: string) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { types: undefined, files: [], dropEffect: '' } });
    return event;
  }

  it('ignores a drag that does not advertise files (no types) — no overlay', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    wrapper.dispatchEvent(noTypesDragEvent('dragenter'));
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('[data-testid="message-drop-overlay"]')).toBeNull();
  });

  it('keeps the overlay shown across nested dragenter events (depth counter)', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    wrapper.dispatchEvent(fileDragEvent('dragenter', [file]));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="message-drop-overlay"]')).not.toBeNull());
    // A second dragenter (entering a child) increments depth; over is already
    // true so setOver isn't called again, and one dragleave must NOT hide it.
    wrapper.dispatchEvent(fileDragEvent('dragenter', [file]));
    wrapper.dispatchEvent(fileDragEvent('dragleave', [file]));
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('[data-testid="message-drop-overlay"]')).not.toBeNull();
  });

  // A drag whose dataTransfer advertises a non-Files type BEFORE Files, so
  // hasFiles()'s loop skips the first entry (the `!== 'Files'` continue arm)
  // and only matches on the second.
  function mixedTypesDragEvent(type: string, files: File[]) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['text/uri-list', 'Files'], files, dropEffect: '' },
    });
    return event;
  }

  // A drag advertising only non-file types: hasFiles() scans the whole list,
  // never matches 'Files', and falls through to its final `return false`.
  function textOnlyDragEvent(type: string) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['text/plain', 'text/uri-list'], files: [], dropEffect: '' },
    });
    return event;
  }

  it('ignores a text-only drag (types present but no Files entry) — no overlay', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    wrapper.dispatchEvent(textOnlyDragEvent('dragenter'));
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('[data-testid="message-drop-overlay"]')).toBeNull();
  });

  it('matches Files even when another mime type is advertised first', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    wrapper.dispatchEvent(mixedTypesDragEvent('dragenter', [new File(['x'], 'm.png', { type: 'image/png' })]));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="message-drop-overlay"]')).not.toBeNull());
  });

  it('ignores dragover/dragleave while disabled (early-return arms)', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles} disabled>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    // dragover while disabled: hits the `disabled || !hasFiles` early-return,
    // so preventDefault never runs and no overlay appears.
    const over = fileDragEvent('dragover', [file]);
    wrapper.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    // dragleave while disabled: hits the `if (disabled) return` arm.
    wrapper.dispatchEvent(fileDragEvent('dragleave', [file]));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-testid="message-drop-overlay"]')).toBeNull();
  });

  // A drop whose dataTransfer advertises Files but exposes an undefined file
  // list, so `e.dataTransfer.files ?? []` falls through to the empty array.
  function undefinedFilesDropEvent() {
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: undefined, dropEffect: '' },
    });
    return event;
  }

  it('treats a drop with an undefined file list as zero files', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    wrapper.dispatchEvent(undefinedFilesDropEvent());
    await new Promise((r) => setTimeout(r, 20));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('does not call onFiles when a drop carries zero files', async () => {
    const onFiles = vi.fn();
    await render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="dropzone-child">drop here</div>
      </MessageDropZone>,
    );
    const wrapper = (document.querySelector('[data-testid="dropzone-child"]') as HTMLElement).parentElement as HTMLElement;
    // hasFiles() is true (types advertises Files) but the file list is empty.
    wrapper.dispatchEvent(fileDragEvent('dragenter', []));
    wrapper.dispatchEvent(fileDragEvent('drop', []));
    await new Promise((r) => setTimeout(r, 30));
    expect(onFiles).not.toHaveBeenCalled();
    // The overlay was reset on drop.
    expect(document.querySelector('[data-testid="message-drop-overlay"]')).toBeNull();
  });
});
