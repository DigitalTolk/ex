import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageDropZone } from '@/components/chat/MessageDropZone';
import { makeDataTransfer } from './dataTransfer';

const dataTransferWith = (files: File[], types: string[] = ['Files']) =>
  makeDataTransfer({ files, types });

describe('MessageDropZone', () => {
  it('shows the overlay while a file drag is in progress', () => {
    render(
      <MessageDropZone onFiles={vi.fn()}>
        <div data-testid="child">child</div>
      </MessageDropZone>,
    );
    const root = screen.getByTestId('child').parentElement!;
    fireEvent.dragEnter(root, { dataTransfer: dataTransferWith([]) });
    expect(screen.getByTestId('message-drop-overlay')).toBeInTheDocument();
  });

  it('ignores drag events that do not carry files', () => {
    render(
      <MessageDropZone onFiles={vi.fn()}>
        <div data-testid="child">child</div>
      </MessageDropZone>,
    );
    const root = screen.getByTestId('child').parentElement!;
    fireEvent.dragEnter(root, { dataTransfer: dataTransferWith([], ['text/plain']) });
    expect(screen.queryByTestId('message-drop-overlay')).toBeNull();
  });

  it('on drop, calls onFiles and hides the overlay', () => {
    const onFiles = vi.fn();
    render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="child">child</div>
      </MessageDropZone>,
    );
    const root = screen.getByTestId('child').parentElement!;
    const f = new File(['hello'], 'hello.png', { type: 'image/png' });
    fireEvent.dragEnter(root, { dataTransfer: dataTransferWith([f]) });
    fireEvent.drop(root, { dataTransfer: dataTransferWith([f]) });
    expect(onFiles).toHaveBeenCalledWith([f]);
    expect(screen.queryByTestId('message-drop-overlay')).toBeNull();
  });

  it('disabled drop zones never show the overlay', () => {
    render(
      <MessageDropZone onFiles={vi.fn()} disabled>
        <div data-testid="child">child</div>
      </MessageDropZone>,
    );
    const root = screen.getByTestId('child').parentElement!;
    fireEvent.dragEnter(root, { dataTransfer: dataTransferWith([]) });
    expect(screen.queryByTestId('message-drop-overlay')).toBeNull();
  });

  it('hides the overlay when the drag leaves all the way out', () => {
    render(
      <MessageDropZone onFiles={vi.fn()}>
        <div data-testid="child">child</div>
      </MessageDropZone>,
    );
    const root = screen.getByTestId('child').parentElement!;
    fireEvent.dragEnter(root, { dataTransfer: dataTransferWith([]) });
    expect(screen.getByTestId('message-drop-overlay')).toBeInTheDocument();
    fireEvent.dragLeave(root);
    expect(screen.queryByTestId('message-drop-overlay')).toBeNull();
  });

  it('keeps the overlay across nested dragenter/dragleave (depth counter)', () => {
    render(
      <MessageDropZone onFiles={vi.fn()}>
        <div data-testid="child">child</div>
      </MessageDropZone>,
    );
    const root = screen.getByTestId('child').parentElement!;
    fireEvent.dragEnter(root, { dataTransfer: dataTransferWith([]) });
    fireEvent.dragEnter(root, { dataTransfer: dataTransferWith([]) }); // crossed a child boundary
    fireEvent.dragLeave(root); // left that child — overlay must stay.
    expect(screen.getByTestId('message-drop-overlay')).toBeInTheDocument();
    fireEvent.dragLeave(root); // and now we leave the root entirely.
    expect(screen.queryByTestId('message-drop-overlay')).toBeNull();
  });

  it('drop with no files is a no-op', () => {
    const onFiles = vi.fn();
    render(
      <MessageDropZone onFiles={onFiles}>
        <div data-testid="child">child</div>
      </MessageDropZone>,
    );
    const root = screen.getByTestId('child').parentElement!;
    fireEvent.drop(root, { dataTransfer: dataTransferWith([], ['text/plain']) });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
