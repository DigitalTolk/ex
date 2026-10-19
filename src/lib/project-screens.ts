// Pure helpers behind the Projects page's screenshot gallery
// (plan-projects-design.md §2).

// A screenshot older than this shows a quiet "may be outdated" hint.
export const SCREEN_STALE_DAYS = 90;

// DESIGN_NOTES_TEMPLATE pre-fills empty design notes: the handful of values a
// screenshot can't tell the agent (fonts by name, exact colors) plus the line
// people fill in once they see what it gets wrong.
export const DESIGN_NOTES_TEMPLATE = `UI stack (component library, icons):
Font:
Primary color:
Background / surface:
Text colors:
Corner radius:
Spacing feel (compact / roomy):
Layout shell (sidebar? top bar? widths):
Icons (library):
Things the agent gets wrong:
`;

// pageNameFromFilename turns "booking-detail_mobile@2x.png" into
// "Booking detail" — a starting point the uploader can correct.
export function pageNameFromFilename(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, '');
  const words = base
    .replace(/@\dx$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(mobile|desktop|phone|screenshot|screen shot|copy)\b/gi, ' ')
    .replace(/\b\d{4}[- ]\d{2}[- ]\d{2}\b.*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

// guessViewport calls a portrait-ish image a phone screenshot.
export function guessViewport(filename: string, width?: number, height?: number): 'desktop' | 'mobile' {
  if (/mobile|phone|iphone|android/i.test(filename)) return 'mobile';
  if (width && height && width / height < 0.8) return 'mobile';
  return 'desktop';
}

// isStale reports whether a screenshot is old enough to hint at a refresh.
export function isStale(updatedAt: string | undefined, now: Date): boolean {
  if (!updatedAt) return false;
  const t = new Date(updatedAt).getTime();
  return Number.isFinite(t) && now.getTime() - t > SCREEN_STALE_DAYS * 86_400_000;
}

// groupByPage groups screens under their page name, keeping the server's
// order (page, desktop before mobile, state).
export function groupByPage<T extends { page: string }>(screens: T[]): { page: string; screens: T[] }[] {
  const groups: { page: string; screens: T[] }[] = [];
  const byKey = new Map<string, { page: string; screens: T[] }>();
  for (const sc of screens) {
    const key = sc.page.trim().toLowerCase();
    let g = byKey.get(key);
    if (!g) {
      g = { page: sc.page, screens: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.screens.push(sc);
  }
  return groups;
}

// readImageSize resolves an image file's pixel size (0×0 if it can't decode).
export function readImageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}
