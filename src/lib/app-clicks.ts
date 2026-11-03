// Clicks this tab sent to apps. A form an app opens in answer carries the
// click's ID, and only the tab that clicked shows it — the person's other
// tabs and devices get the same event and ignore it. IDs stay known for the
// tab's life (a form can open in answer to a submission much later), capped
// so a long session can't grow it without end.
const MAX_CLICKS = 200;
const mine = new Set<string>();

// Where a click came from: the card whose line follows what the click led
// to (a form opened, sent or closed).
export interface ClickOrigin {
  messageID: string;
}
const origins = new Map<string, ClickOrigin>();

function randomID(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// newClickID names one click from this tab, and remembers its card.
export function newClickID(origin?: ClickOrigin): string {
  const id = randomID();
  mine.add(id);
  if (origin) origins.set(id, origin);
  if (mine.size > MAX_CLICKS) {
    const oldest = mine.values().next().value as string;
    mine.delete(oldest);
    origins.delete(oldest);
  }
  return id;
}

// clickOrigin is the card a click of this tab came from, if it came from one.
export const clickOrigin = (id: string | undefined) => (id ? origins.get(id) : undefined);

// isOwnClick reports whether this tab sent the click id names.
export function isOwnClick(id: string | undefined): boolean {
  return !!id && mine.has(id);
}
