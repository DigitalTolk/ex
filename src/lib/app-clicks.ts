// Clicks this tab sent to apps. A form an app opens in answer carries the
// click's ID, and only the tab that clicked shows it — the person's other
// tabs and devices get the same event and ignore it. IDs stay known for the
// tab's life (a form can open in answer to a submission much later), capped
// so a long session can't grow it without end.
const MAX_CLICKS = 200;
const mine = new Set<string>();

function randomID(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// newClickID names one click from this tab.
export function newClickID(): string {
  const id = randomID();
  mine.add(id);
  if (mine.size > MAX_CLICKS) mine.delete(mine.values().next().value as string);
  return id;
}

// isOwnClick reports whether this tab sent the click id names.
export function isOwnClick(id: string | undefined): boolean {
  return !!id && mine.has(id);
}
