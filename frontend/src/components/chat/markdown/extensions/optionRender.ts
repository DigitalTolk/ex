import type { Completion } from '@codemirror/autocomplete';
import { shortcodeToUnicode } from '@/lib/emoji-shortcodes';

// Rich rendering for the composer's autocomplete options. CodeMirror only draws
// a label + detail by default; we attach a `meta` payload to each completion and
// render a custom row (avatar / channel icon / large emoji + a two-line text
// column) via the autocompletion `addToOptions` hook, restoring the look of the
// old Lexical typeahead. The default `.cm-completionLabel`/`.cm-completionDetail`
// are hidden in the theme since every composer option carries a custom row.

export type OptionMeta =
  | { kind: 'user'; displayName: string; email?: string; avatarURL?: string; online: boolean; statusEmoji?: string }
  | { kind: 'group'; title: string; description: string }
  | { kind: 'channel'; slug: string; isPrivate: boolean }
  | { kind: 'emoji'; name: string; glyph?: string; imageURL?: string };

export interface MentionCompletion extends Completion {
  meta?: OptionMeta;
}

// lucide Hash / Lock, inlined (static markup — safe to set via innerHTML).
const HASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>';
const LOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function textCol(title: string, sub?: string): HTMLElement {
  const col = el('div', 'cm-option-col');
  col.appendChild(el('div', 'cm-option-title', title));
  if (sub) col.appendChild(el('div', 'cm-option-sub', sub));
  return col;
}

function avatarEl(m: { displayName: string; avatarURL?: string; online: boolean }): HTMLElement {
  const a = el('span', 'cm-option-avatar');
  if (m.avatarURL) {
    const img = document.createElement('img');
    img.src = m.avatarURL;
    img.alt = '';
    a.appendChild(img);
  } else {
    a.textContent = (m.displayName.trim()[0] ?? '?').toUpperCase();
  }
  if (m.online) a.appendChild(el('span', 'cm-option-dot'));
  return a;
}

function svgIcon(svg: string): HTMLElement {
  const s = el('span', 'cm-option-icon');
  s.innerHTML = svg;
  return s;
}

export function renderMentionOption(completion: Completion): Node | null {
  const meta = (completion as MentionCompletion).meta;
  if (!meta) return null;
  const row = el('div', 'cm-option-row');
  if (meta.kind === 'user') {
    row.appendChild(avatarEl(meta));
    const col = el('div', 'cm-option-col');
    const titleRow = el('div', 'cm-option-title-row');
    titleRow.appendChild(el('span', 'cm-option-title', meta.displayName));
    if (meta.statusEmoji) {
      // Active custom-status emoji (resolve a :shortcode: to its glyph).
      titleRow.appendChild(el('span', 'cm-option-status', shortcodeToUnicode(meta.statusEmoji)));
    }
    col.appendChild(titleRow);
    if (meta.email) col.appendChild(el('div', 'cm-option-sub', meta.email));
    row.appendChild(col);
  } else if (meta.kind === 'group') {
    // @all / @here render with an avatar-style circle showing "@", matching the
    // user avatars beside them.
    row.appendChild(el('span', 'cm-option-avatar cm-option-group', '@'));
    row.appendChild(textCol(meta.title, meta.description));
  } else if (meta.kind === 'channel') {
    row.appendChild(svgIcon(meta.isPrivate ? LOCK_SVG : HASH_SVG));
    row.appendChild(textCol(`~${meta.slug}`));
  } else {
    const glyph = el('span', 'cm-option-emoji');
    if (meta.glyph) {
      glyph.textContent = meta.glyph;
    } else if (meta.imageURL) {
      const img = document.createElement('img');
      img.src = meta.imageURL;
      img.alt = '';
      glyph.appendChild(img);
    }
    row.appendChild(glyph);
    row.appendChild(textCol(`:${meta.name}:`));
  }
  return row;
}
