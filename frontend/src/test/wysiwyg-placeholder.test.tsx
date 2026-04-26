import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { WysiwygEditor } from '@/components/chat/WysiwygEditor';

describe('WysiwygEditor placeholder', () => {
  it('exposes the provided placeholder text on data-placeholder when empty', () => {
    render(<WysiwygEditor value="" onChange={() => {}} placeholder="Write to #general" />);
    const el = screen.getByRole('textbox');
    expect(el.getAttribute('data-placeholder')).toBe('Write to #general');
  });

  it('still keeps the data-placeholder attribute populated even with content (CSS hides it via :empty)', () => {
    render(<WysiwygEditor value="<p>hi</p>" onChange={() => {}} placeholder="Write to #general" />);
    const el = screen.getByRole('textbox');
    expect(el.getAttribute('data-placeholder')).toBe('Write to #general');
  });

  it('global stylesheet renders the placeholder via .wysiwyg-editor:empty::before', () => {
    // Pin the CSS contract: the only way the placeholder is visible inside a
    // contentEditable is via this rule, and we don't want a future cleanup to
    // delete it without noticing.
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    expect(css).toMatch(/\.wysiwyg-editor:empty::before/);
    expect(css).toMatch(/content:\s*attr\(data-placeholder\)/);
  });
});
