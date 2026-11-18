// A workspace is known by the server it runs on: its icon is the favicon that
// server serves (the tab's icon too), and its name the address people type to
// reach it. Nothing to configure in the app, and each server gets its own.

export function serverIconURL(): string {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href || '/favicon.svg';
}

export function serverName(): string {
  return window.location.hostname.replace(/^www\./, '');
}
