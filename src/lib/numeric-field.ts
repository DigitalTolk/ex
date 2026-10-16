// A whole number typed into a text field — never <input type="number">, whose
// spinner steals the scroll wheel and arrow keys and which reports '' for
// anything it can't parse. Keeps the digits and clamps them into [min, max];
// an emptied field stays empty ("not set").
export function wholeNumberField(raw: string, min: number, max = Number.MAX_SAFE_INTEGER): string {
  const digits = raw.replace(/\D/g, '').slice(0, 15);
  if (digits === '') return '';
  return String(Math.min(max, Math.max(min, Number(digits))));
}
