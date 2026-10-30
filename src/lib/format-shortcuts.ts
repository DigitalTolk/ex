// The composer's formatting keys, as Slack has them: ⌘ on Apple platforms,
// Ctrl elsewhere.
export type FormatAction = 'bold' | 'italic' | 'strike' | 'code' | 'quote' | 'ul' | 'ol' | 'link';

export interface FormatShortcut {
  // The editor's key binding (CodeMirror: Mod is ⌘ on Apple, Ctrl elsewhere).
  key: string;
  // Shown in the formatting button's tooltip.
  label: string;
  // As aria-keyshortcuts names it.
  aria: string;
}

const KEYS: Record<FormatAction, { key: string; shift: boolean }> = {
  bold: { key: 'B', shift: false },
  italic: { key: 'I', shift: false },
  strike: { key: 'X', shift: true },
  code: { key: 'C', shift: true },
  quote: { key: '9', shift: true },
  ul: { key: '8', shift: true },
  ol: { key: '7', shift: true },
  link: { key: 'U', shift: true },
};

export function formatShortcuts(apple: boolean): Record<FormatAction, FormatShortcut> {
  const out = {} as Record<FormatAction, FormatShortcut>;
  for (const action of Object.keys(KEYS) as FormatAction[]) {
    const { key, shift } = KEYS[action];
    out[action] = {
      key: `Mod-${shift ? 'Shift-' : ''}${key.toLowerCase()}`,
      label: apple ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl ${shift ? 'Shift ' : ''}${key}`,
      aria: `${apple ? 'Meta' : 'Control'}+${shift ? 'Shift+' : ''}${key}`,
    };
  }
  return out;
}
