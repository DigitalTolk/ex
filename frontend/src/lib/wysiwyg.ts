import { USER_MENTION_RE_GLOBAL } from './mention-syntax';

// Minimal markdown ↔ HTML bridge for the message composer.
//
// The editor is a contentEditable div: the user types and applies marks
// (bold/italic/etc.), the DOM holds the source of truth visually, and
// these helpers convert in/out of markdown so the wire format stays
// markdown. We deliberately keep the supported mark set narrow — exactly
// what the formatting toolbar exposes — so round-tripping is lossless
// for normal use.
//
// Supported marks (toolbar parity):
//   **bold**    *italic*    ~~strikethrough~~    `inline code`
//   [text](url) bare URL    > blockquote line    - unordered list item
//   1. ordered list item
//
// Anything else (headings, etc.) survives in markdown source even if not
// shown in the toolbar — the editor just doesn't apply visual styling.

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll("'", '&#39;');
}

// Apply inline markdown (bold/italic/strike/code/link) to a single line of
// already HTML-escaped text. The replacements run in priority order so a
// link's text isn't accidentally interpreted as italic, etc.
function inlineMd(s: string): string {
  // @[id|name] → mention pill (must come BEFORE the link rule so the
  // bracket pair isn't interpreted as a link's [text]).
  s = s.replace(USER_MENTION_RE_GLOBAL, (_m, id: string, name: string) => {
    const safeID = escapeAttr(id.trim());
    const safeName = name.trim();
    // The pill is contenteditable=false so the cursor steps over it as
    // an atomic token instead of letting the user split it character by
    // character. The trailing zero-width space (\u200B) gives the editor
    // a position to land the caret right after the pill.
    return `<span class="mention" data-user-id="${safeID}" data-mention-name="${escapeAttr(safeName)}" contenteditable="false">@${escapeHtml(safeName)}</span>`;
  });
  // [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) =>
    `<a href="${escapeAttr(url)}">${text}</a>`,
  );
  // **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // ~~strike~~
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  // *italic* — avoid eating leading ** that already became <strong>
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // `inline code`
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return s;
}

// Convert markdown to the HTML shape the editor expects on initial load
// (and after restoring drafts). Block-level support: paragraphs (split on
// blank lines), unordered lists (`- `), ordered lists (`1. `), and
// blockquotes (`> `).
export function markdownToEditableHtml(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Blank line — separator only.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(inlineMd(escapeHtml(lines[i].replace(/^[-*]\s+/, ''))));
        i++;
      }
      out.push('<ul>' + items.map((t) => `<li>${t}</li>`).join('') + '</ul>');
      continue;
    }

    // Ordered list.
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(inlineMd(escapeHtml(lines[i].replace(/^\d+[.)]\s+/, ''))));
        i++;
      }
      out.push('<ol>' + items.map((t) => `<li>${t}</li>`).join('') + '</ol>');
      continue;
    }

    // Blockquote.
    if (/^>\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s+/.test(lines[i])) {
        buf.push(inlineMd(escapeHtml(lines[i].replace(/^>\s+/, ''))));
        i++;
      }
      out.push(`<blockquote>${buf.join('<br>')}</blockquote>`);
      continue;
    }

    // Paragraph (consecutive non-special lines, joined with <br>).
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s+/.test(lines[i])
    ) {
      paragraph.push(inlineMd(escapeHtml(lines[i])));
      i++;
    }
    out.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return out.join('');
}

// Walk the DOM and emit markdown. Whitespace between blocks gets a single
// blank line. Inline marks reuse the standard markdown delimiters.
export function htmlToMarkdown(root: Node): string {
  const out: string[] = [];
  for (const child of Array.from(root.childNodes)) {
    appendNode(child, out, []);
  }
  // Collapse runs of blank lines down to a single blank, trim ends.
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

type Mark = 'b' | 'i' | 's' | 'code';
const markDelim: Record<Mark, string> = { b: '**', i: '*', s: '~~', code: '`' };

function appendNode(node: Node, out: string[], marks: Mark[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (!text) return;
    out.push(wrapMarks(text, marks));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'br':
      out.push('\n');
      return;
    case 'p':
    case 'div':
      // Block — flush a leading newline if needed, recurse, then trailing.
      ensureBlankLine(out);
      for (const c of Array.from(el.childNodes)) appendNode(c, out, marks);
      out.push('\n\n');
      return;
    case 'ul':
      ensureBlankLine(out);
      for (const c of Array.from(el.childNodes)) {
        if (c.nodeType === Node.ELEMENT_NODE && (c as HTMLElement).tagName.toLowerCase() === 'li') {
          out.push('- ');
          for (const cc of Array.from(c.childNodes)) appendNode(cc, out, marks);
          out.push('\n');
        }
      }
      out.push('\n');
      return;
    case 'ol':
      ensureBlankLine(out);
      {
        let n = 1;
        for (const c of Array.from(el.childNodes)) {
          if (c.nodeType === Node.ELEMENT_NODE && (c as HTMLElement).tagName.toLowerCase() === 'li') {
            out.push(`${n}. `);
            for (const cc of Array.from(c.childNodes)) appendNode(cc, out, marks);
            out.push('\n');
            n++;
          }
        }
      }
      out.push('\n');
      return;
    case 'blockquote':
      ensureBlankLine(out);
      {
        const inner: string[] = [];
        for (const c of Array.from(el.childNodes)) appendNode(c, inner, marks);
        const text = inner.join('').replace(/\n+$/, '');
        for (const line of text.split('\n')) {
          out.push(`> ${line}\n`);
        }
        out.push('\n');
      }
      return;
    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const text: string[] = [];
      for (const c of Array.from(el.childNodes)) appendNode(c, text, marks);
      const inner = text.join('');
      // Bare URL collapses to its href when text equals the URL.
      if (inner === href) {
        out.push(href);
      } else {
        out.push(`[${inner}](${href})`);
      }
      return;
    }
    case 'b':
    case 'strong':
      for (const c of Array.from(el.childNodes)) appendNode(c, out, [...marks, 'b']);
      return;
    case 'i':
    case 'em':
      for (const c of Array.from(el.childNodes)) appendNode(c, out, [...marks, 'i']);
      return;
    case 's':
    case 'strike':
    case 'del':
      for (const c of Array.from(el.childNodes)) appendNode(c, out, [...marks, 's']);
      return;
    case 'code':
      for (const c of Array.from(el.childNodes)) appendNode(c, out, [...marks, 'code']);
      return;
    case 'span': {
      // Mention pill: <span class="mention" data-user-id="X" data-mention-name="Bob">
      // The textContent ("@Bob") is for display only — we serialise from
      // the data attributes so a user editing the visible name (which
      // contenteditable shouldn't allow but might via paste) can't
      // desync the routing identifier.
      if (el.classList.contains('mention')) {
        const id = el.getAttribute('data-user-id') ?? '';
        const name =
          el.getAttribute('data-mention-name') ??
          (el.textContent ?? '').replace(/^@/, '');
        if (id) {
          out.push(`@[${id}|${name}]`);
          return;
        }
      }
      for (const c of Array.from(el.childNodes)) appendNode(c, out, marks);
      return;
    }
    default:
      // Unknown element — recurse into children, drop the wrapper.
      for (const c of Array.from(el.childNodes)) appendNode(c, out, marks);
  }
}

function wrapMarks(text: string, marks: Mark[]): string {
  let s = text;
  for (const m of marks) {
    s = `${markDelim[m]}${s}${markDelim[m]}`;
  }
  return s;
}

function ensureBlankLine(out: string[]) {
  // Avoid stacking 3+ newlines when consecutive blocks meet.
  const tail = out.join('').slice(-2);
  if (tail.endsWith('\n\n') || out.length === 0) return;
  if (tail.endsWith('\n')) {
    out.push('\n');
  } else {
    out.push('\n\n');
  }
}
