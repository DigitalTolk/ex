import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { PASTE_COMMAND, type LexicalEditor } from 'lexical';
import { useEffect } from 'react';
import { PasteFilesPlugin } from './PasteFilesPlugin';

function Capture({ onReady }: { onReady: (e: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { onReady(editor); }, [editor, onReady]);
  return null;
}

async function mount(onPasteFiles?: (files: File[]) => void): Promise<LexicalEditor> {
  let editor!: LexicalEditor;
  await render(
    <LexicalComposer initialConfig={{ namespace: 'paste-files', onError: (e) => { throw e; }, theme: {} }}>
      <RichTextPlugin contentEditable={<ContentEditable />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
      <PasteFilesPlugin onPasteFiles={onPasteFiles} />
      <Capture onReady={(e) => { editor = e; }} />
    </LexicalComposer>,
  );
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return editor;
}

type Item = { kind: string; getAsFile: () => File | null };
function pasteEvent(items: Item[] | null) {
  return {
    clipboardData: items === null ? null : { items },
    preventDefault: () => {},
    // make the default Lexical handler see only file-less text
    getData: () => '',
  } as unknown as ClipboardEvent;
}

const aFile = new File(['x'], 'shot.png', { type: 'image/png' });

describe('PasteFilesPlugin (browser)', () => {
  it('routes pasted files to the onPasteFiles callback', async () => {
    const onPaste = vi.fn();
    const editor = await mount(onPaste);
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent([{ kind: 'file', getAsFile: () => aFile }]));
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste.mock.calls[0][0]).toEqual([aFile]);
  });

  it('ignores a paste with no clipboard items', async () => {
    const onPaste = vi.fn();
    const editor = await mount(onPaste);
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent(null));
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('skips non-file clipboard items', async () => {
    const onPaste = vi.fn();
    const editor = await mount(onPaste);
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent([{ kind: 'string', getAsFile: () => null }]));
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('skips file items whose getAsFile returns null', async () => {
    const onPaste = vi.fn();
    const editor = await mount(onPaste);
    editor.dispatchCommand(PASTE_COMMAND, pasteEvent([{ kind: 'file', getAsFile: () => null }]));
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('does not register the command when no callback is provided', async () => {
    // Mounting without onPasteFiles exercises the early-return guard; the
    // command simply isn't registered, so a paste is a no-op here.
    const editor = await mount(undefined);
    expect(() => editor.dispatchCommand(PASTE_COMMAND, pasteEvent([{ kind: 'file', getAsFile: () => aFile }]))).not.toThrow();
  });
});
