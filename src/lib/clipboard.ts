// copyToClipboard writes text to the clipboard, falling back to a hidden
// textarea + execCommand for environments without the async Clipboard API
// (jsdom, older browsers, non-secure contexts).
export async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* swallow — best effort */
    }
    ta.remove();
  }
}

// pastedFiles returns the files a paste should attach. Copied files arrive in
// `files`; a screenshot can arrive only as a `kind:'file'` item.
//
// Word, Outlook, Excel and other rich-text sources also put a rendered
// picture of the selection on the clipboard next to its text and HTML. That
// copy is text the user wants to paste, so when the only files are images and
// the clipboard also carries both HTML and non-blank plain text, nothing is
// attached and the editor pastes the text. A copied image (browser "Copy
// image", a screenshot) has no plain text; a file copied in Finder has no HTML.
export function pastedFiles(dt: DataTransfer): File[] {
  const files = Array.from(dt.files);
  if (files.length === 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length > 0 && isRenderedTextSnapshot(dt, files)) return [];
  return files;
}

function isRenderedTextSnapshot(dt: DataTransfer, files: File[]): boolean {
  return (
    files.every((f) => f.type.startsWith('image/')) &&
    dt.getData('text/html') !== '' &&
    dt.getData('text/plain').trim() !== ''
  );
}
