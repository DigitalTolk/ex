// Artifact marker parsing — the backend drops a
// "[artifact:runID:artifactID|title|kind|bytes]" message when a run
// publishes an artifact; the chat renders it as an ArtifactCard.

export interface ArtifactMarker {
  runID: string;
  artifactID: string;
  title: string;
  kind: string;
  bytes: number;
}

const MARKER_RE = /^\[artifact:([A-Za-z0-9]+):([A-Za-z0-9]+)\|([^|\]]*)\|([^|\]]*)\|(\d+)\]$/;

// parseArtifactMarker recognizes an artifact marker message body.
export function parseArtifactMarker(body: string): ArtifactMarker | null {
  const m = MARKER_RE.exec(body.trim());
  if (!m) return null;
  return {
    runID: m[1],
    artifactID: m[2],
    title: m[3].trim() || 'Untitled artifact',
    kind: m[4].trim() || 'text',
    bytes: Number(m[5]),
  };
}

