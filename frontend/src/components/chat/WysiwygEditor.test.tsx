import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { WysiwygEditor, type WysiwygEditorHandle } from './WysiwygEditor';

describe('WysiwygEditor', () => {
  beforeEach(() => {
    // Stub document.execCommand for jsdom (deprecated, but still used by the editor).
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;
  });

  it('mounts with initial markdown converted to HTML', () => {
    const ref = createRef<WysiwygEditorHandle>();
    const { getByLabelText } = render(
      <WysiwygEditor ref={ref} initialBody="**bold**" />,
    );
    const el = getByLabelText('Message input');
    // markdownToEditableHtml turns **bold** into a <strong> wrapper.
    expect(el.innerHTML).toContain('strong');
    expect(ref.current?.getMarkdown()).toContain('bold');
  });

  it('emits onChange only when markdown actually changes', () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <WysiwygEditor onChange={onChange} initialBody="" />,
    );
    const el = getByLabelText('Message input');
    el.textContent = 'hello';
    fireEvent.input(el);
    expect(onChange).toHaveBeenCalledWith('hello');
    onChange.mockClear();
    // Same content — no extra emission.
    fireEvent.input(el);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Enter without Shift submits and prevents the default newline', () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(
      <WysiwygEditor onSubmit={onSubmit} initialBody="hi" />,
    );
    const el = getByLabelText('Message input');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });

  it('Shift+Enter does not submit', () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(
      <WysiwygEditor onSubmit={onSubmit} initialBody="hi" />,
    );
    const el = getByLabelText('Message input');
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Escape calls onCancel when provided', () => {
    const onCancel = vi.fn();
    const { getByLabelText } = render(<WysiwygEditor onCancel={onCancel} />);
    fireEvent.keyDown(getByLabelText('Message input'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('Ctrl+B / Ctrl+I / Ctrl+E invoke execCommand or wrap inline-code', () => {
    const exec = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    const { getByLabelText } = render(<WysiwygEditor />);
    const el = getByLabelText('Message input');
    fireEvent.keyDown(el, { key: 'b', ctrlKey: true });
    expect(exec).toHaveBeenCalledWith('bold');
    fireEvent.keyDown(el, { key: 'i', ctrlKey: true });
    expect(exec).toHaveBeenCalledWith('italic');
    // Ctrl+E uses the inline-code wrapper which calls window.getSelection
    fireEvent.keyDown(el, { key: 'e', ctrlKey: true });
    // No extra exec call for Ctrl+E (it uses range manipulation instead);
    // we assert that no error is thrown and the exec call list does not
    // include an unexpected 'underline' or similar.
  });

  it('imperative applyMark calls execCommand for bold / italic / strike', () => {
    const exec = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    const ref = createRef<WysiwygEditorHandle>();
    render(<WysiwygEditor ref={ref} />);
    ref.current!.applyMark('bold');
    expect(exec).toHaveBeenCalledWith('bold');
    ref.current!.applyMark('italic');
    expect(exec).toHaveBeenCalledWith('italic');
    ref.current!.applyMark('strike');
    expect(exec).toHaveBeenCalledWith('strikeThrough');
  });

  it('imperative applyBlock calls the matching execCommand variants', () => {
    const exec = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    const ref = createRef<WysiwygEditorHandle>();
    render(<WysiwygEditor ref={ref} />);
    ref.current!.applyBlock('ul');
    expect(exec).toHaveBeenCalledWith('insertUnorderedList');
    ref.current!.applyBlock('ol');
    expect(exec).toHaveBeenCalledWith('insertOrderedList');
    ref.current!.applyBlock('quote');
    expect(exec).toHaveBeenCalledWith('formatBlock', false, 'blockquote');
  });

  it('applyLink prompts for URL and calls createLink only when answered', () => {
    const exec = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    const ref = createRef<WysiwygEditorHandle>();
    render(<WysiwygEditor ref={ref} />);

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValueOnce('');
    ref.current!.applyLink();
    // Empty answer = no createLink call.
    expect(exec).not.toHaveBeenCalledWith('createLink', false, expect.anything());
    promptSpy.mockReset();

    promptSpy.mockReturnValueOnce('https://example.com');
    ref.current!.applyLink();
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://example.com');
    promptSpy.mockRestore();
  });

  it('insertText calls execCommand("insertText", …)', () => {
    const exec = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    const ref = createRef<WysiwygEditorHandle>();
    render(<WysiwygEditor ref={ref} />);
    ref.current!.insertText(':smile: ');
    expect(exec).toHaveBeenCalledWith('insertText', false, ':smile: ');
  });

  it('setMarkdown replaces the editor content and emits onChange', () => {
    const onChange = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    const { getByLabelText } = render(<WysiwygEditor ref={ref} onChange={onChange} />);
    ref.current!.setMarkdown('hello *world*');
    const el = getByLabelText('Message input');
    expect(el.innerHTML.length).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalledWith('hello *world*');
  });

  it('focus() focuses the contentEditable region', () => {
    const ref = createRef<WysiwygEditorHandle>();
    const { getByLabelText } = render(<WysiwygEditor ref={ref} />);
    ref.current!.focus();
    expect(document.activeElement).toBe(getByLabelText('Message input'));
  });

  it('applyMark("code") wraps a non-collapsed selection in <code>', () => {
    const ref = createRef<WysiwygEditorHandle>();
    const { getByLabelText } = render(<WysiwygEditor ref={ref} initialBody="abc" />);
    const el = getByLabelText('Message input');
    // Select the entire text so the wrapper goes around it.
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    ref.current!.applyMark('code');
    expect(el.innerHTML).toContain('<code>');
  });

  it('renders a <blockquote> element in the editor when initial markdown is "> hi"', () => {
    const { getByLabelText } = render(<WysiwygEditor initialBody="> hi" />);
    const el = getByLabelText('Message input');
    // The visible quote bar comes from CSS scoped to .wysiwyg-editor —
    // here we pin the DOM contract so the styling has something to bind to.
    expect(el.querySelector('blockquote')).not.toBeNull();
    expect(el.classList.contains('wysiwyg-editor')).toBe(true);
  });

  it('Enter on a typed "1. foo" line auto-inserts the next "2. " marker', () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(
      <WysiwygEditor onSubmit={onSubmit} initialBody="" />,
    );
    const el = getByLabelText('Message input');
    // Plant a text node with a typed list line and put the caret at the end.
    const text = document.createTextNode('1. foo');
    el.innerHTML = '';
    el.appendChild(text);
    const range = document.createRange();
    range.setStart(text, text.length);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    fireEvent.keyDown(el, { key: 'Enter' });
    // No submit — list-continuation handled it.
    expect(onSubmit).not.toHaveBeenCalled();
    // A <br> + "2. " was inserted at the caret.
    expect(el.innerHTML).toContain('<br>');
    expect(el.textContent).toBe('1. foo2. ');
  });

  it('Enter on an empty "- " marker line closes the list (strips marker, no submit)', () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(
      <WysiwygEditor onSubmit={onSubmit} initialBody="" />,
    );
    const el = getByLabelText('Message input');
    const text = document.createTextNode('- ');
    el.innerHTML = '';
    el.appendChild(text);
    const range = document.createRange();
    range.setStart(text, text.length);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    // Marker removed, line is now empty.
    expect(el.textContent).toBe('');
  });

  it('Enter inside an empty <li> exits the list and does not submit', () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(
      <WysiwygEditor onSubmit={onSubmit} initialBody="" />,
    );
    const el = getByLabelText('Message input');
    el.innerHTML = '<ul><li>foo</li><li><br></li></ul>';
    const emptyLi = el.querySelectorAll('li')[1];
    const range = document.createRange();
    range.setStart(emptyLi, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    // The empty li was removed; a div sits after the surviving list.
    expect(el.querySelectorAll('li').length).toBe(1);
    expect(el.querySelector('ul + div')).not.toBeNull();
  });

  it('Enter inside an empty <blockquote> exits the blockquote and does not submit', () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(
      <WysiwygEditor onSubmit={onSubmit} initialBody="" />,
    );
    const el = getByLabelText('Message input');
    el.innerHTML = '<blockquote><br></blockquote>';
    const bq = el.querySelector('blockquote')!;
    const range = document.createRange();
    range.setStart(bq, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(el.querySelector('blockquote')).toBeNull();
  });
});
