// What to tell the reader when a search didn't come back.
export function searchFailure(error: unknown): string {
  return error instanceof DOMException && error.name === 'TimeoutError' ? 'Search timed out' : 'Search failed';
}
