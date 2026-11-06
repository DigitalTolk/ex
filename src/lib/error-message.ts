// errorMessage is what a failed request says to the user: the error's own
// message, or `fallback` for anything that isn't an Error.
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}
