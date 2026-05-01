import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Safe URL gate for anything we render as a clickable link or pass to
// TOGGLE_LINK_COMMAND. Must reject `javascript:`, `data:`, `vbscript:`,
// and any non-absolute strings — those become XSS vectors when wrapped
// in an <a href>. Whitelist http/https only.
export function isHttpUrl(text: string): boolean {
  if (!text || /\s/.test(text)) return false;
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
