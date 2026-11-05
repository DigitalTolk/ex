// wheelTo turns the open picker's time wheels to a time (hour 0–23) with the
// keyboard — a/p for AM or PM, then ↑ on each wheel until it shows the hour
// and the minute — since only the rows around a wheel's box are drawn to tap.
// `key` sends a keydown (fireEvent.keyDown under jsdom).
export function wheelTo(
  hour: number,
  minute: number,
  key: (el: HTMLElement, key: string) => void = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })),
  prefix = 'reminder',
) {
  const wheel = (part: string) => document.querySelector<HTMLElement>(`[data-testid="${prefix}-wheel-${part}"]`);
  const turn = (part: string, target: number) => {
    const el = wheel(part)!;
    const n = Number(el.getAttribute('aria-valuemax')) + 1;
    const steps = (target - Number(el.getAttribute('aria-valuenow')) + n) % n;
    for (let i = 0; i < steps; i++) key(el, 'ArrowUp');
  };
  if (wheel('period')) {
    key(wheel('period')!, hour >= 12 ? 'p' : 'a');
    turn('hour', (hour % 12 || 12) - 1);
  } else {
    turn('hour', hour);
  }
  turn('minute', minute);
}
