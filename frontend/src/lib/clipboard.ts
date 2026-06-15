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
