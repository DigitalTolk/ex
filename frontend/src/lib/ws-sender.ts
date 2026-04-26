// ws-sender is a tiny singleton that lets any component send a frame
// over the open WebSocket without having to thread the connection
// through React context. The lifecycle is owned by useWebSocket — it
// installs a sender on connect and clears it on close.

type Sender = (frame: string) => void;

let current: Sender | null = null;

export function setWSSender(s: Sender | null): void {
  current = s;
}

export function sendWS(payload: unknown): void {
  if (!current) return;
  try {
    current(JSON.stringify(payload));
  } catch {
    // ignore — we'll succeed on the next reconnect.
  }
}
