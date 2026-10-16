// Hidden markers the design agent (Apelles) puts in its posts. They are HTML
// comments, so the server-rendered message never shows them; the client reads
// them from the raw body:
//   <!-- ex:before <project key>/<reference screenshot attachment id> -->
//       → "Compare with the real page" slider under the post
//   <!-- ex:design-note <project key> | <rule> -->
//       → a one-click "add to design notes" suggestion

export interface DesignMarkers {
  before: { project: string; attachmentID: string } | null;
  notes: { project: string; text: string }[];
}

const BEFORE_RE = /<!--\s*ex:before\s+([a-z0-9][a-z0-9-]*)\/(?:att:)?([A-Za-z0-9]+)\s*-->/;
const NOTE_RE = /<!--\s*ex:design-note\s+([a-z0-9][a-z0-9-]*)\s*\|\s*([\s\S]*?)\s*-->/g;

// hasDesignMarkers is the cheap per-row check: most messages have none.
export function hasDesignMarkers(body: string): boolean {
  return body.includes('<!--') && body.includes('ex:');
}

export function parseDesignMarkers(body: string): DesignMarkers {
  const b = BEFORE_RE.exec(body);
  const notes: DesignMarkers['notes'] = [];
  for (const m of body.matchAll(NOTE_RE)) {
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text) notes.push({ project: m[1], text });
  }
  return { before: b ? { project: b[1], attachmentID: b[2] } : null, notes };
}

// LEARNED_HEADING groups the rules people saved from agent suggestions at the
// end of a project's design notes.
export const LEARNED_HEADING = 'Learned from feedback:';

// appendDesignNote adds a rule under the learned-from-feedback heading
// (creating it once), leaving the rest of the notes untouched.
export function appendDesignNote(notes: string, rule: string): string {
  const line = `- ${rule}`;
  const base = notes.trimEnd();
  if (base.includes(LEARNED_HEADING)) return `${base}\n${line}`;
  return base ? `${base}\n\n${LEARNED_HEADING}\n${line}` : `${LEARNED_HEADING}\n${line}`;
}

// noteSaved reports whether the notes already carry the rule.
export function noteSaved(notes: string | undefined, rule: string): boolean {
  return !!notes && notes.toLowerCase().includes(rule.toLowerCase());
}
